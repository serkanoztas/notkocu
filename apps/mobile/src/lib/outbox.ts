import { AUDIO_IMPORT_MAX_BYTES, AUDIO_MAX_TOTAL_BYTES } from "@notkocu/shared";
import { Directory, File, Paths } from "expo-file-system";
import { api, ApiError } from "./api";

// Offline outbox. A note is written to the device first (text, link address and a COPY of any file in
// the app's document folder), then sent; it stays here until the server confirms it. Each note has a
// clientId, so a send that was cut off and repeated can never create a second note on the server.
//
// Layout:  <documents>/outbox/<clientId>/entry.json   (written last: a folder without it is junk)
//                                       /<file name>   (photo / document)

export type OutboxKind = "text" | "image" | "document" | "link" | "audio";

/** Where the note goes, decided when it was taken. Absent = the server decides from capturedAt. */
export interface OutboxTarget {
  /** null = inbox */
  courseId: string | null;
  weekNo?: number;
  /** Imported audio: the session of that lesson, when the course has several. */
  sessionId?: string;
}

export interface OutboxEntry {
  clientId: string;
  userId: string;
  kind: OutboxKind;
  /** ISO time the note was taken; the target and the note's date follow it, not the time it is sent. */
  capturedAt: string;
  source: "app" | "share-intent" | "import";
  /** Audio: an external file (one file, not recorded here); sent to the import endpoint. */
  imported?: boolean;
  target?: OutboxTarget;
  title?: string;
  markdown?: string;
  url?: string;
  /** Name of the copied file inside the entry folder. */
  fileName?: string;
  /** Name shown in lists (original file name). */
  displayName?: string;
  /** Audio: the pieces of the recording, in order (files inside the entry folder) with their measured length. */
  chunks?: { fileName: string; durationSec: number }[];
  /** Audio: still being recorded (or the app died while recording). Such an entry is never sent until it is closed. */
  recording?: boolean;
  /** Set when the server refused the note for good (e.g. storage full); it is not retried by itself. */
  error?: { code: string; message: string };
}

const outboxDir = () => new Directory(Paths.document, "outbox");
const entryDir = (clientId: string) => new Directory(outboxDir(), clientId);
export const entryDirectory = entryDir;

/** Unique enough per user (the server only needs uniqueness, not secrecy). */
export function newClientId(): string {
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(36).padStart(7, "0");
  return `n${Date.now().toString(36)}-${rand()}${rand()}`;
}

const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100) || "dosya";

/** Writes the entry (and the copy of its file) to disk. entry.json goes last. */
export async function writeNewEntry(entry: OutboxEntry, source?: { uri: string; name: string }): Promise<OutboxEntry> {
  const dir = entryDir(entry.clientId);
  dir.create({ intermediates: true, idempotent: true });
  let saved = entry;
  if (source) {
    const fileName = safeFileName(source.name);
    await new File(source.uri).copy(new File(dir, fileName), { overwrite: true });
    saved = { ...entry, fileName, displayName: entry.displayName ?? source.name };
  }
  const json = new File(dir, "entry.json");
  json.create({ overwrite: true });
  await json.write(JSON.stringify(saved));
  return saved;
}

/** Rewrites entry.json after a change (target fallback, error state). */
export async function updateEntry(entry: OutboxEntry): Promise<void> {
  const json = new File(entryDir(entry.clientId), "entry.json");
  json.create({ overwrite: true });
  await json.write(JSON.stringify(entry));
}

export function removeEntry(clientId: string): void {
  try {
    const dir = entryDir(clientId);
    if (dir.exists) dir.delete();
  } catch {
    // already gone
  }
}

export function clearOutbox(): void {
  try {
    if (outboxDir().exists) outboxDir().delete();
  } catch {
    // nothing to clean
  }
}

/** All complete entries, oldest first; folders without a readable entry.json are removed. */
export async function loadEntries(): Promise<OutboxEntry[]> {
  const root = outboxDir();
  if (!root.exists) return [];
  const out: OutboxEntry[] = [];
  for (const item of root.list()) {
    if (!(item instanceof Directory)) continue;
    try {
      const json = new File(item, "entry.json");
      if (!json.exists) throw new Error("incomplete");
      out.push(JSON.parse(await json.text()) as OutboxEntry);
    } catch {
      try {
        item.delete(); // half-written when the app was killed
      } catch {
        // ignore
      }
    }
  }
  return out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

/** Sends one entry. Throws ApiError on failure. */
export async function sendEntry(entry: OutboxEntry): Promise<void> {
  const meta = { clientId: entry.clientId, capturedAt: entry.capturedAt, source: entry.source };
  const target = entry.target;

  if (entry.kind === "audio" && entry.imported) {
    if (!entry.fileName) throw new ApiError("Dosya bulunamadı", 400, "FILE_REQUIRED");
    const file = new File(entryDir(entry.clientId), entry.fileName);
    if (!file.exists) throw new ApiError("Dosya bulunamadı", 400, "FILE_REQUIRED");
    if (file.size > AUDIO_IMPORT_MAX_BYTES) throw new ApiError("Ses dosyası çok büyük", 413, "AUDIO_TOO_LARGE");
    await api.importAudioNote(file.uri, { ...target }, meta, entry.title);
    return;
  }
  if (entry.kind === "audio") {
    const dir = entryDir(entry.clientId);
    const pieces = (entry.chunks ?? []).map((c) => ({ file: new File(dir, c.fileName), durationSec: c.durationSec }));
    if (pieces.length === 0 || pieces.some((p) => !p.file.exists)) throw new ApiError("Dosya bulunamadı", 400, "FILE_REQUIRED");
    if (pieces.reduce((n, p) => n + p.file.size, 0) > AUDIO_MAX_TOTAL_BYTES) throw new ApiError("Kayıt çok büyük", 413, "AUDIO_TOO_LARGE");
    await api.createAudioNote(pieces.map((p) => p.file.uri), pieces.map((p) => p.durationSec), { ...target }, meta, entry.title);
    return;
  }
  if (entry.kind === "image" || entry.kind === "document") {
    if (!entry.fileName) throw new ApiError("Dosya bulunamadı", 400, "FILE_REQUIRED");
    const file = new File(entryDir(entry.clientId), entry.fileName);
    if (!file.exists) throw new ApiError("Dosya bulunamadı", 400, "FILE_REQUIRED");
    await api.createFileNote(entry.kind, file.uri, { ...target }, meta, entry.title);
    return;
  }
  const where = target ? (target.courseId === null ? { courseId: null } : { courseId: target.courseId, weekNo: target.weekNo }) : {};
  if (entry.kind === "link") {
    await api.createNote({ type: "link", url: entry.url ?? "", title: entry.title, ...where, ...meta });
  } else {
    await api.createNote({ type: "text", markdown: entry.markdown ?? "", title: entry.title, ...where, ...meta });
  }
}

export function errorMessage(err: ApiError): string {
  switch (err.code) {
    case "STORAGE_LIMIT":
      return "Depolama alanın doldu";
    case "FILE_TOO_LARGE":
    case "IMAGE_TOO_LARGE":
      return "Dosya çok büyük";
    case "UNSUPPORTED_DOCUMENT_TYPE":
    case "UNSUPPORTED_IMAGE_TYPE":
      return "Dosya türü desteklenmiyor";
    case "AUDIO_TOO_LARGE":
      return "Ses çok büyük (kayıt en fazla 60 MB, içe aktarılan dosya en fazla 100 MB)";
    case "UNSUPPORTED_AUDIO_TYPE":
      return "Ses biçimi desteklenmiyor (m4a, mp3, wav, ogg/opus, flac, aac)";
    case "UNREADABLE_AUDIO":
      return "Ses dosyasının süresi okunamadı";
    case "SESSION_REQUIRED":
    case "INVALID_SESSION":
      return "Dersin oturumu seçilmeli";
    case "FILE_REQUIRED":
      return "Dosya bulunamadı";
    default:
      return `Sunucu kabul etmedi${err.status ? ` (${err.status})` : ""}`;
  }
}

/** Worth trying again later (no connection, server trouble, session) vs refused for good. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.status === undefined) return true; // network / timeout / client-side failure
  return err.status >= 500 || err.status === 429 || err.status === 401 || err.status === 408;
}
