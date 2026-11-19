import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { AUDIO_CHUNK_SEC, AUDIO_MAX_CHUNKS } from "@notkocu/shared";
import { Directory, File, Paths } from "expo-file-system";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { useOutbox } from "./OutboxProvider";
import {
  entryDirectory,
  loadEntries,
  newClientId,
  removeEntry,
  updateEntry,
  writeNewEntry,
  type OutboxEntry,
  type OutboxTarget,
} from "./outbox";

// Lecture recording. The recording is cut into ~10 minute pieces, each closed and moved into the outbox
// entry folder as soon as it is done, so whatever kills the app (the system, a call, the battery) costs
// at most the piece in progress. Android writes raw ADTS AAC (.aac): a cut-off file is still playable and
// transcribable, so even that piece is recovered at the next launch. Background recording is a foreground
// service (the expo-audio config plugin) with a persistent notification.
//
// Layout while recording:  <documents>/Audio/rec-<clientId>-<NNN>.aac   (written by expo-audio)
//                          <documents>/outbox/<clientId>/entry.json     (recording: true, chunks so far)
//                          <documents>/outbox/<clientId>/chunk-<NNN>.aac (closed pieces)

const RECORDING_OPTIONS: RecordingOptions = {
  extension: ".aac",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 24000, // speech: 90 min is about 16 MB
  directory: "document", // the cache folder may be emptied by the system
  android: { outputFormat: "aac_adts", audioEncoder: "aac" },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.LOW },
  web: {},
};

const TICK_MS = 500;
const MIN_PIECE_BYTES = 2000; // smaller than this is only a header
const MIN_PIECE_SEC = 1;
const AUTO_RESUME_TRIES = 5;
const AUTO_RESUME_EVERY_MS = 2000;

const pad = (n: number) => String(n).padStart(3, "0");
const recName = (clientId: string, index: number) => `rec-${clientId}-${pad(index)}`;
const chunkName = (index: number) => `chunk-${pad(index)}.aac`;
const estimateSec = (bytes: number) => Math.max(1, Math.round((bytes * 8) / 24_000)); // 24 kbps CBR

export type RecordingStatus = "idle" | "starting" | "recording" | "paused" | "interrupted" | "finishing";

export interface RecordingValue {
  status: RecordingStatus;
  /** Length of the whole recording so far (all pieces), seconds. */
  elapsedSec: number;
  error: string | null;
  /** Recordings rescued at launch after the app died; the UI says so once. */
  recoveredCount: number;
  dismissRecovered: () => void;
  /** Where the note goes was decided by the caller at the moment of starting. */
  start: (opts: { target?: OutboxTarget; title?: string }) => Promise<boolean>;
  pause: () => void;
  resume: () => Promise<void>;
  /** Closes the recording and hands it to the outbox. */
  finish: () => Promise<boolean>;
  /** Throws the recording away. */
  discard: () => Promise<void>;
}

const RecordingContext = createContext<RecordingValue | null>(null);

interface Live {
  entry: OutboxEntry | null;
  /** Seconds in the closed pieces. */
  base: number;
  /** Index of the piece being (or about to be) recorded. */
  index: number;
  /** A piece is open in the recorder. */
  open: boolean;
  /** rotate / interruption handling in progress: the tick leaves the recorder alone. */
  busy: boolean;
  resumeTries: number;
  lastResumeAt: number;
  status: RecordingStatus;
}

/** Files expo-audio left for this recording (documents/Audio first, cache/Audio as a fallback). */
function orphanFiles(clientId: string): File[] {
  const out: File[] = [];
  for (const root of [Paths.document, Paths.cache]) {
    try {
      const dir = new Directory(root, "Audio");
      if (!dir.exists) continue;
      for (const item of dir.list()) {
        if (item instanceof File && item.name.startsWith(`rec-${clientId}-`)) out.push(item);
      }
    } catch {
      // folder not readable: nothing to rescue there
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Moves the files left behind for an entry into its folder and closes the entry. Returns false when nothing was usable. */
async function rescueEntry(entry: OutboxEntry): Promise<boolean> {
  const chunks = [...(entry.chunks ?? [])];
  const taken = new Set(chunks.map((c) => c.fileName));
  for (const file of orphanFiles(entry.clientId)) {
    const index = Number(/-(\d{3})\.[^.]+$/.exec(file.name)?.[1] ?? NaN);
    if (!Number.isInteger(index)) continue;
    const name = chunkName(index);
    if (taken.has(name)) continue;
    const size = file.size;
    if (size < MIN_PIECE_BYTES) {
      try {
        file.delete();
      } catch {
        // ignore
      }
      continue;
    }
    try {
      await file.move(new File(entryDirectory(entry.clientId), name));
      chunks.push({ fileName: name, durationSec: estimateSec(size) });
      taken.add(name);
    } catch {
      // could not move this piece: keep going with the others
    }
  }
  chunks.sort((a, b) => a.fileName.localeCompare(b.fileName));
  if (chunks.length === 0) {
    removeEntry(entry.clientId);
    return false;
  }
  await updateEntry({ ...entry, chunks, recording: false });
  return true;
}

export function RecordingProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, user } = useAuth();
  const userId = authStatus === "signedIn" ? (user?._id ?? null) : null;
  const outbox = useOutbox();
  const recorder = useAudioRecorder(RECORDING_OPTIONS);

  const [status, setStatusState] = useState<RecordingStatus>("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recoveredCount, setRecoveredCount] = useState(0);
  const live = useRef<Live>({ entry: null, base: 0, index: 0, open: false, busy: false, resumeTries: 0, lastResumeAt: 0, status: "idle" });

  const setStatus = useCallback((s: RecordingStatus) => {
    live.current.status = s;
    setStatusState(s);
  }, []);

  /** Starts piece `index` in the recorder. */
  const beginPiece = useCallback(async () => {
    const l = live.current;
    await recorder.prepareToRecordAsync({ fileName: recName(l.entry!.clientId, l.index) });
    recorder.record();
    l.open = true;
  }, [recorder]);

  /** Closes the open piece and moves it into the entry folder. A piece that is only a header is dropped. */
  const closePiece = useCallback(async () => {
    const l = live.current;
    if (!l.open || !l.entry) return;
    l.open = false;
    let seconds = 0;
    try {
      seconds = recorder.getStatus().durationMillis / 1000;
    } catch {
      // status unreadable: the size decides below
    }
    try {
      await recorder.stop();
    } catch {
      // already stopped by the system
    }
    const uri = recorder.uri;
    if (!uri) return;
    const src = new File(uri);
    if (!src.exists) return;
    const size = src.size;
    if (size < MIN_PIECE_BYTES || (seconds > 0 && seconds < MIN_PIECE_SEC)) {
      try {
        src.delete();
      } catch {
        // ignore
      }
      return;
    }
    const duration = seconds >= MIN_PIECE_SEC ? Math.round(seconds * 10) / 10 : estimateSec(size);
    const name = chunkName(l.index);
    await src.move(new File(entryDirectory(l.entry.clientId), name));
    l.entry = { ...l.entry, chunks: [...(l.entry.chunks ?? []), { fileName: name, durationSec: duration }] };
    await updateEntry(l.entry); // after this the piece survives anything
    l.base += duration;
    l.index += 1;
  }, [recorder]);

  const closeEntry = useCallback(async (): Promise<boolean> => {
    const l = live.current;
    const entry = l.entry;
    l.entry = null;
    l.open = false;
    try {
      await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
    } catch {
      // the mode is only a hint once recording is over
    }
    if (!entry) return false;
    if ((entry.chunks?.length ?? 0) === 0) {
      removeEntry(entry.clientId);
      return false;
    }
    await updateEntry({ ...entry, recording: false });
    await outbox.reload(); // picks the entry up and sends it
    return true;
  }, [outbox]);

  const finish = useCallback(async (): Promise<boolean> => {
    const l = live.current;
    if (l.status === "idle" || l.status === "finishing" || l.status === "starting") return false;
    setStatus("finishing");
    for (let i = 0; i < 50 && l.busy; i++) await new Promise((r) => setTimeout(r, 100)); // a rotation in progress
    try {
      await closePiece();
    } catch {
      setError("Son parça kaydedilemedi");
    }
    const ok = await closeEntry();
    if (!ok) setError("Kayıt boş olduğu için kaydedilmedi");
    setElapsedSec(0);
    setStatus("idle");
    return ok;
  }, [closeEntry, closePiece, setStatus]);

  const rotate = useCallback(async () => {
    const l = live.current;
    l.busy = true;
    try {
      await closePiece();
      if (l.index >= AUDIO_MAX_CHUNKS) {
        l.busy = false;
        await finish(); // the longest recording the server accepts
        return;
      }
      await beginPiece();
    } catch {
      setStatus("interrupted"); // the pieces so far are safe; the user (or the retry below) continues
    } finally {
      l.busy = false;
    }
  }, [beginPiece, closePiece, finish, setStatus]);

  // The clock, the piece rollover and the detection of a recorder that stopped by itself (a call, the system).
  useEffect(() => {
    if (status === "idle" || status === "starting" || status === "finishing") return;
    const id = setInterval(() => {
      const l = live.current;
      if (l.busy) return;
      let st;
      try {
        st = recorder.getStatus();
      } catch {
        return;
      }
      const piece = l.open ? st.durationMillis / 1000 : 0;
      setElapsedSec(l.base + piece);

      if (l.status === "recording") {
        if (l.open && !st.isRecording) {
          // Stopped without us: close what exists and try to carry on in a new piece.
          l.busy = true;
          l.resumeTries = 0;
          l.lastResumeAt = Date.now();
          void closePiece()
            .catch(() => undefined)
            .finally(() => {
              l.busy = false;
              setStatus("interrupted");
            });
        } else if (piece >= AUDIO_CHUNK_SEC) {
          void rotate();
        }
      } else if (l.status === "interrupted" && l.resumeTries < AUTO_RESUME_TRIES && Date.now() - l.lastResumeAt > AUTO_RESUME_EVERY_MS) {
        l.resumeTries += 1;
        l.lastResumeAt = Date.now();
        l.busy = true;
        void beginPiece()
          .then(() => setStatus("recording"))
          .catch(() => undefined)
          .finally(() => {
            l.busy = false;
          });
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [status, recorder, closePiece, rotate, beginPiece, setStatus]);

  const start = useCallback(
    async (opts: { target?: OutboxTarget; title?: string }): Promise<boolean> => {
      const l = live.current;
      if (l.status !== "idle" || !userId) return false;
      setError(null);
      setStatus("starting");
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setError("Mikrofon izni gerekli. Ayarlardan izin verebilirsin.");
          setStatus("idle");
          return false;
        }
        await setAudioModeAsync({
          allowsRecording: true,
          allowsBackgroundRecording: true, // keeps recording with the screen off (foreground service)
          playsInSilentMode: true,
          interruptionMode: "doNotMix",
        });
        const entry: OutboxEntry = {
          clientId: newClientId(),
          userId,
          kind: "audio",
          capturedAt: new Date().toISOString(), // the start of the recording decides the week
          source: "app",
          target: opts.target,
          title: opts.title,
          chunks: [],
          recording: true,
        };
        await writeNewEntry(entry);
        Object.assign(l, { entry, base: 0, index: 0, open: false, busy: false, resumeTries: 0 });
        await beginPiece();
        setElapsedSec(0);
        setStatus("recording");
        return true;
      } catch {
        if (l.entry) removeEntry(l.entry.clientId);
        l.entry = null;
        l.open = false;
        setError("Kayıt başlatılamadı");
        setStatus("idle");
        return false;
      }
    },
    [beginPiece, setStatus, userId],
  );

  const pause = useCallback(() => {
    if (live.current.status !== "recording") return;
    try {
      recorder.pause();
      setStatus("paused");
    } catch {
      setError("Kayıt duraklatılamadı");
    }
  }, [recorder, setStatus]);

  const resume = useCallback(async () => {
    const l = live.current;
    if (l.status === "paused") {
      try {
        recorder.record();
        await new Promise((r) => setTimeout(r, 400));
        if (recorder.getStatus().isRecording) {
          setStatus("recording");
          return;
        }
      } catch {
        // fall through: continue in a new piece
      }
      l.busy = true;
      try {
        await closePiece();
        await beginPiece();
        setStatus("recording");
      } catch {
        setStatus("interrupted");
      } finally {
        l.busy = false;
      }
    } else if (l.status === "interrupted" && !l.busy) {
      l.busy = true;
      try {
        await beginPiece();
        setStatus("recording");
      } catch {
        setError("Kayıt devam ettirilemedi");
      } finally {
        l.busy = false;
      }
    }
  }, [beginPiece, closePiece, recorder, setStatus]);

  const discard = useCallback(async () => {
    const l = live.current;
    if (l.status === "idle") return;
    l.busy = true;
    try {
      await recorder.stop();
    } catch {
      // not recording
    }
    const entry = l.entry;
    l.entry = null;
    l.open = false;
    if (entry) {
      for (const f of orphanFiles(entry.clientId)) {
        try {
          f.delete();
        } catch {
          // ignore
        }
      }
      removeEntry(entry.clientId);
    }
    try {
      await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
    } catch {
      // ignore
    }
    l.busy = false;
    setElapsedSec(0);
    setStatus("idle");
  }, [recorder, setStatus]);

  // After the app died (or was killed) mid-recording: close the entry with every piece that is on disk.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      let rescued = 0;
      for (const e of await loadEntries()) {
        if (e.userId !== userId || e.kind !== "audio" || !e.recording) continue;
        if (e.clientId === live.current.entry?.clientId) continue; // being recorded right now
        if (await rescueEntry(e)) rescued += 1;
      }
      if (cancelled) return;
      if (rescued > 0) setRecoveredCount((n) => n + rescued);
      await outbox.reload();
    })();
    return () => {
      cancelled = true;
    };
    // Once per sign-in: reload identity changes with every render of the outbox value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const value = useMemo<RecordingValue>(
    () => ({
      status,
      elapsedSec,
      error,
      recoveredCount,
      dismissRecovered: () => setRecoveredCount(0),
      start,
      pause,
      resume,
      finish,
      discard,
    }),
    [status, elapsedSec, error, recoveredCount, start, pause, resume, finish, discard],
  );
  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecording(): RecordingValue {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error("useRecording must be used inside RecordingProvider");
  return ctx;
}
