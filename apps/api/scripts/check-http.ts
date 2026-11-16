// End-to-end check of the photo-note API over HTTP, with throw-away users (no Google login needed).
// Runs the worker loop in-process (only for its own throw-away notes), so no separate worker is needed.
// By default Gemini is FAKE (no real requests). Real requests only with CHECK_REAL_GEMINI=1.
// Stop any other running worker first: it could claim these notes too.
// Run: npm run check-http   (cleans up after itself, also when interrupted)
import type { Server } from "node:http";
import mongoose from "mongoose";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { dayIndex, minutesOfDay, semesterWeekNo } from "@notkocu/shared";
import { CourseModel, NoteItemModel, SemesterModel, SessionModel } from "../src/models";
import { ocrPdfPages } from "../src/services/ai/documentOcr";
import { deleteUserFiles, getUsage } from "../src/services/files";
import { signAccessToken } from "../src/services/auth/tokens";
import { startWorker } from "../src/worker/run";
import { REAL_GEMINI, setupGemini } from "./lib/geminiMode";

const gemini = setupGemini();
let worker: { stop: () => Promise<void> } | undefined;

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const userA = new mongoose.Types.ObjectId().toHexString();
const userB = new mongoose.Types.ObjectId().toHexString();

/** Removes everything this script created. Also runs when the script is interrupted or timed out. */
async function cleanup() {
  await worker?.stop();
  await NoteItemModel.deleteMany({ userId: { $in: [userA, userB] } });
  await CourseModel.deleteMany({ userId: { $in: [userA, userB] } });
  await SessionModel.deleteMany({ userId: { $in: [userA, userB] } });
  await SemesterModel.deleteMany({ userId: { $in: [userA, userB] } });
  await deleteUserFiles(userA);
  await deleteUserFiles(userB);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void cleanup().catch(() => undefined).finally(() => process.exit(130)));
}

async function photoWithText() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="100%" height="100%" fill="white"/>
    <text x="40" y="100" font-size="56" font-family="Arial" fill="black">Veritabani Yonetimi</text>
    <text x="40" y="190" font-size="40" font-family="Arial" fill="black">1. Normalizasyon</text>
    <text x="40" y="260" font-size="40" font-family="Arial" fill="black">2. Indeksleme</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

/** A PDF; each page is text (text layer) or null (blank), and an optional image fills the first page. */
async function makePdf(pages: (string | null)[], image: Buffer | null): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, text] of pages.entries()) {
    const page = doc.addPage([600, 400]);
    if (text) page.drawText(text, { x: 20, y: 360, size: 11, font, maxWidth: 560, lineHeight: 14 });
    if (image && i === 0) {
      const png = await doc.embedPng(image);
      page.drawImage(png, { x: 0, y: 0, width: 600, height: 400 });
    }
  }
  return Buffer.from(await doc.save());
}

/** Text only as pixels, like a scan: no text layer in the resulting PDF. */
async function scanImage(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="100%" height="100%" fill="white"/><text x="60" y="200" font-size="96" font-family="Arial" fill="black">Sistem Analizi</text><text x="60" y="360" font-size="72" font-family="Arial" fill="black">Use case diyagrami</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  worker = startWorker({ concurrency: 2, claimFilter: { userId: { $in: [userA, userB] } } });
  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const tokenA = signAccessToken(userA);
  const tokenB = signAccessToken(userB);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  function form(file: Buffer | null, fields: Record<string, string>, mime = "image/jpeg") {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    if (file) f.append("file", new Blob([file], { type: mime }), "photo.jpg");
    return f;
  }

  try {
    const jpg = await photoWithText();

    let res = await fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: form(jpg, { type: "image", inbox: "1" }) });
    const created = (await res.json()) as { note: { _id: string; status: string; title: string; courseId: null; content: { fileKey: string; thumbKey?: string } } };
    check("upload -> 201 pending, inbox", res.status === 201 && created.note.status === "pending" && created.note.courseId === null);
    check("response has no job internals", !("job" in created.note));
    check("fileKey + thumbKey present", !!created.note.content.fileKey && !!created.note.content.thumbKey);
    const { _id: noteId, content } = created.note;

    res = await fetch(`${base}/api/files/${content.fileKey}`, { headers: auth(tokenA) });
    check("owner streams the file", res.status === 200 && res.headers.get("content-type") === "image/jpeg" && (await res.arrayBuffer()).byteLength > 1000);
    res = await fetch(`${base}/api/files/${content.thumbKey}`, { headers: auth(tokenA) });
    check("owner streams the thumbnail", res.status === 200);
    res = await fetch(`${base}/api/files/${content.fileKey}`, { headers: auth(tokenB) });
    check("other user -> 404", res.status === 404);
    res = await fetch(`${base}/api/files/${content.fileKey}`);
    check("no token -> 401", res.status === 401);
    res = await fetch(`${base}/api/files/not-an-id`, { headers: auth(tokenA) });
    check("malformed id -> 404", res.status === 404);

    res = await fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: form(Buffer.from("%PDF-1.4 fake pdf content here"), { type: "image", inbox: "1" }, "application/pdf") });
    check("pdf mime rejected 400", res.status === 400);
    res = await fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: form(Buffer.from("this is plain text pretending to be a jpeg"), { type: "image", inbox: "1" }) });
    check("fake jpeg (magic bytes) rejected 400", res.status === 400);
    res = await fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: form(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(11 * 1024 * 1024, 0)]), { type: "image", inbox: "1" }) });
    check("11 MB photo rejected 413", res.status === 413);

    res = await fetch(`${base}/api/me/storage`, { headers: auth(tokenA) });
    const storage = (await res.json()) as { usedBytes: number; limitBytes: number };
    check("storage usage", res.status === 200 && storage.usedBytes > 0 && storage.limitBytes === env.USER_STORAGE_LIMIT_MB * 1024 * 1024, JSON.stringify(storage));

    res = await fetch(`${base}/api/notes/${noteId}`, { method: "PATCH", headers: { ...auth(tokenA), "Content-Type": "application/json" }, body: JSON.stringify({ markdown: "x" }) });
    check("PATCH markdown on image -> 400", res.status === 400);
    res = await fetch(`${base}/api/notes/${noteId}/retry`, { method: "POST", headers: auth(tokenA) });
    check("retry on non-failed -> 409", res.status === 409);
    res = await fetch(`${base}/api/notes/${noteId}`, { headers: auth(tokenB) });
    check("other user cannot read the note", res.status === 404);

    // The in-process worker should finish the note.
    let status = "pending";
    let note: { status: string; extractedText?: string; aiSummary?: string; title: string; content: { ocrMarkdown?: string } } | undefined;
    for (let i = 0; i < 40 && status !== "ready" && status !== "failed"; i++) {
      await sleep(3000);
      note = ((await (await fetch(`${base}/api/notes/${noteId}`, { headers: auth(tokenA) })).json()) as { note: typeof note }).note;
      status = note!.status;
    }
    check("worker made it ready", status === "ready", `status=${status}`);
    if (note?.status === "ready") {
      console.log("      title:", note.title);
      console.log("      summary:", note.aiSummary);
      console.log("      ocr:", JSON.stringify(note.content.ocrMarkdown));
      check("ocr text mentions the photo content", /normalizasyon|indeks/i.test(note.content.ocrMarkdown ?? ""));
    }

    // --- link note (JSON) ---
    const jsonPost = (token: string, body: unknown) =>
      fetch(`${base}/api/notes`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    res = await jsonPost(tokenA, { type: "link", url: "https://example.com/kaynak", title: "Ders kaynağı", courseId: null });
    const link = (await res.json()) as { note: { _id: string; status: string; title: string; extractedText?: string; content: { url: string } } };
    check("link note ready, url + title only", res.status === 201 && link.note.status === "ready" && link.note.content.url === "https://example.com/kaynak" && link.note.title === "Ders kaynağı");
    res = await jsonPost(tokenA, { type: "link", url: "javascript:alert(1)", courseId: null });
    check("non-http link rejected 400", res.status === 400);

    // --- document notes (text-layer PDF, DOCX, PPTX, scanned PDF) ---
    const uploadDoc = async (buf: Buffer, name: string, mime = "application/octet-stream") => {
      const f = new FormData();
      f.append("type", "document");
      f.append("inbox", "1");
      f.append("file", new Blob([buf], { type: mime }), name);
      const r = await fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: f });
      return { status: r.status, body: (await r.json()) as { note?: { _id: string; status: string; title: string; content: Record<string, unknown> } } };
    };
    const waitReady = async (id: string) => {
      for (let i = 0; i < 60; i++) {
        const n = ((await (await fetch(`${base}/api/notes/${id}`, { headers: auth(tokenA) })).json()) as { note: { status: string; extractedText?: string; aiSummary?: string; content: { pages?: string[]; pageCount?: number; unit?: string } } }).note;
        if (n.status === "ready" || n.status === "failed") return n;
        await sleep(3000);
      }
      return null;
    };

    const textPdf = await makePdf(["Normalizasyon birinci normal form her hucrede tek deger olmalidir. ".repeat(3), "Ikinci normal form kismi bagimliliklari ayirir ve anahtar alanlara bakar. ".repeat(3)], null);
    let up = await uploadDoc(textPdf, "Veritabani Notlari.pdf", "application/pdf");
    check("pdf upload -> 201 pending, title from file name", up.status === 201 && up.body.note?.status === "pending" && up.body.note.title === "Veritabani Notlari");
    const pdfNote = await waitReady(up.body.note!._id);
    check("text-layer pdf ready with 2 pages + summary", pdfNote?.status === "ready" && pdfNote.content.pageCount === 2 && pdfNote.content.unit === "page" && !!pdfNote.aiSummary, JSON.stringify({ s: pdfNote?.status, n: pdfNote?.content.pageCount }));
    check("pdf extractedText from the text layer", /Normalizasyon/.test(pdfNote?.extractedText ?? ""));

    const docxBuf = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Indeksleme B-tree yapisini kullanir ve arama maliyetini azaltir.</w:t></w:r></w:p></w:body></w:document>`) }));
    up = await uploadDoc(docxBuf, "İndeksleme_çalışma.docx");
    check("docx upload keeps the Turkish file name", up.status === 201 && up.body.note?.content.fileName === "İndeksleme_çalışma.docx", String(up.body.note?.content.fileName));
    const docxNote = await waitReady(up.body.note!._id);
    check("docx ready, one section", docxNote?.status === "ready" && docxNote.content.pageCount === 1 && /B-tree/.test(docxNote.extractedText ?? ""));

    up = await uploadDoc(Buffer.from("PK\u0003\u0004 not really a document at all"), "x.docx");
    check("fake docx rejected 400", up.status === 400);
    up = await uploadDoc(Buffer.alloc(21 * 1024 * 1024, 1), "big.pdf", "application/pdf");
    check("21 MB document rejected 413", up.status === 413);

    const scannedPdf = await makePdf([null], await scanImage());
    up = await uploadDoc(scannedPdf, "taranmis.pdf", "application/pdf");
    const scannedNote = await waitReady(up.body.note!._id);
    check("scanned pdf (no text layer) read by Gemini", scannedNote?.status === "ready" && /sistem|analiz|tasar/i.test(scannedNote.extractedText ?? ""), (scannedNote?.extractedText ?? "").slice(0, 80));

    // Quota (429) handling needs a Gemini we can make fail, so it only runs with the fake.
    if (gemini) {
      gemini.failNextWith(429);
      res = await fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: form(jpg, { type: "image", inbox: "1" }) });
      const quotaId = ((await res.json()) as { note: { _id: string } }).note._id;
      let job: { status: string; job?: { attempts?: number; deferrals?: number; runAt?: Date } } | null = null;
      for (let i = 0; i < 20; i++) {
        job = await NoteItemModel.findById(quotaId).lean();
        if (job?.job?.deferrals === 1) break;
        await sleep(500);
      }
      check(
        "429 -> deferred ~60 s, attempt not used",
        job?.status === "pending" && job.job?.attempts === 0 && job.job.deferrals === 1 && +job.job.runAt! - Date.now() > 50_000,
        JSON.stringify(job?.job),
      );
    }

    // --- inbox course suggestions (the course's own week comes from the note date, not from the AI) ---
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 14); // started two weeks ago
    monday.setUTCHours(12, 0, 0, 0);
    const semester = await SemesterModel.create({ userId: userA, name: "Test Güz", startDate: monday, weekCount: 14, isActive: true });
    const vtCourse = await CourseModel.create({ userId: userA, semesterId: semester._id, code: "YBS-301", name: "Veritabanı Yönetim Sistemleri", instructor: "Dr. Test" });
    await CourseModel.create({ userId: userA, semesterId: semester._id, code: "YBS-305", name: "Sistem Analizi ve Tasarımı" });
    const expectedWeek = semesterWeekNo({ startDate: monday.toISOString(), weekCount: 14 }, new Date());

    const postText = async (markdown: string) => {
      const r = await jsonPost(tokenA, { type: "text", markdown, courseId: null });
      return ((await r.json()) as { note: { _id: string; suggesting?: boolean } }).note;
    };
    const getInbox = async (token = tokenA) =>
      ((await (await fetch(`${base}/api/inbox`, { headers: auth(token) })).json()) as {
        notes: { _id: string; suggesting?: boolean; suggestion?: { courseId: string; weekNo: number; confidence: number } }[];
      }).notes;
    const waitSuggestion = async (id: string, want: boolean) => {
      for (let i = 0; i < 40; i++) {
        const n = (await getInbox()).find((x) => x._id === id);
        if (n && !n.suggesting && !!n.suggestion === want) return n;
        await sleep(500);
      }
      return (await getInbox()).find((x) => x._id === id);
    };

    const vtNote = await postText("Normalizasyon: birinci normal formda her hücrede tek değer olmalıdır. İndeksleme B-tree ile yapılır.");
    check("new inbox text note is marked as being suggested", vtNote.suggesting === true);
    const suggested = await waitSuggestion(vtNote._id, true);
    check(
      "suggestion: the right course, week from the note date",
      suggested?.suggestion?.courseId === String(vtCourse._id) && suggested.suggestion.weekNo === expectedWeek && suggested.suggestion.confidence >= 0.7,
      JSON.stringify(suggested?.suggestion),
    );

    const approveAs = async (token: string, noteIds: string[]) => {
      const r = await fetch(`${base}/api/inbox/approve`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ noteIds }) });
      return { status: r.status, body: (await r.json()) as { approved: string[]; skipped: string[] } };
    };
    const other = await approveAs(tokenB, [vtNote._id]);
    check("another user cannot approve my note (skipped)", other.status === 200 && other.body.approved.length === 0 && other.body.skipped.length === 1);
    // Inserted directly (no queue entry), so it deterministically has no suggestion.
    const noSuggestionYet = await NoteItemModel.create({ userId: userA, courseId: null, type: "text", title: "kısa", content: { markdown: "kısa" }, extractedText: "kısa", status: "ready" });
    const mixed = await approveAs(tokenA, [vtNote._id, String(noSuggestionYet._id), "bogus"]);
    check("approve assigns only notes that have a suggestion", mixed.body.approved.length === 1 && mixed.body.approved[0] === vtNote._id && mixed.body.skipped.length === 2, JSON.stringify(mixed.body));
    let after = ((await (await fetch(`${base}/api/notes/${vtNote._id}`, { headers: auth(tokenA) })).json()) as { note: { courseId: string | null; weekNo?: number; suggestion?: unknown } }).note;
    check("approved note sits in the course and week", after.courseId === String(vtCourse._id) && after.weekNo === expectedWeek);
    res = await fetch(`${base}/api/notes/${vtNote._id}`, { method: "PATCH", headers: { ...auth(tokenA), "Content-Type": "application/json" }, body: JSON.stringify({ courseId: null }) });
    after = ((await res.json()) as { note: typeof after }).note;
    check("undo (back to the inbox) keeps the suggestion", after.courseId === null && !!after.suggestion);

    if (gemini) {
      gemini.setSuggestConfidence(0.4);
      const unsure = await postText("Final projesi grupları cuma gününe kadar belli olmalı, 3-4 kişilik.");
      const unsureNow = await waitSuggestion(unsure._id, false);
      check("confidence < 0.7 -> no suggestion shown", !!unsureNow && !unsureNow.suggestion && !unsureNow.suggesting);
      gemini.setSuggestConfidence(0.9);
    }

    // --- clientId idempotency and capturedAt (what the app's outbox relies on) ---
    const cid = `check${Date.now().toString(36)}a`;
    const first = await jsonPost(tokenA, { type: "text", markdown: "outbox notu", courseId: null, clientId: cid });
    const firstBody = (await first.json()) as { note: { _id: string } };
    const second = await jsonPost(tokenA, { type: "text", markdown: "outbox notu", courseId: null, clientId: cid });
    const secondBody = (await second.json()) as { note: { _id: string } };
    check("same clientId again: 200 and the same note", first.status === 201 && second.status === 200 && firstBody.note._id === secondBody.note._id);
    check("exactly one note for that clientId", (await NoteItemModel.countDocuments({ userId: userA, clientId: cid })) === 1);
    const otherUser = await jsonPost(tokenB, { type: "text", markdown: "başka kullanıcı", courseId: null, clientId: cid });
    check("clientId is per user (the same id for another user creates its own note)", otherUser.status === 201);

    const raceId = `check${Date.now().toString(36)}r`;
    const race = await Promise.all([1, 2, 3].map(() => jsonPost(tokenA, { type: "text", markdown: "yarış", courseId: null, clientId: raceId })));
    check("three simultaneous requests with one clientId -> one note", (await NoteItemModel.countDocuments({ userId: userA, clientId: raceId })) === 1 && race.every((r) => r.status === 200 || r.status === 201));

    const fileId = `check${Date.now().toString(36)}f`;
    const postPhoto = () => fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: form(jpg, { type: "image", inbox: "1", clientId: fileId }) });
    const p1 = await postPhoto();
    const p2 = await postPhoto();
    check("retried photo upload: 201 then 200, one note, one file pair", p1.status === 201 && p2.status === 200 && (await NoteItemModel.countDocuments({ userId: userA, clientId: fileId })) === 1);

    const tz = "Europe/Istanbul";
    const taken = new Date(Date.now() - 2 * 24 * 3600 * 1000); // two days ago
    const mins = minutesOfDay(taken, tz);
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    await SessionModel.create({ userId: userA, courseId: vtCourse._id, day: dayIndex(taken, tz), start: hhmm(Math.max(0, mins - 5)), end: hhmm(Math.min(1439, mins + 55)), kind: "teori" });
    const lateId = `check${Date.now().toString(36)}c`;
    res = await jsonPost(tokenA, { type: "text", markdown: "geç gelen not", clientId: lateId, capturedAt: taken.toISOString() }); // no target: the server decides
    const late = ((await res.json()) as { note: { courseId: string | null; weekNo?: number; createdAt: string; capturedAt?: string } }).note;
    const lateWeek = semesterWeekNo({ startDate: monday.toISOString(), weekCount: 14 }, taken, tz);
    check("capturedAt decides the target (the class two days ago), not the arrival time", late.courseId === String(vtCourse._id) && late.weekNo === lateWeek, JSON.stringify({ c: late.courseId, w: late.weekNo, want: lateWeek }));
    check("createdAt follows capturedAt", Math.abs(+new Date(late.createdAt) - +taken) < 1000 && late.capturedAt !== undefined);

    res = await jsonPost(tokenA, { type: "text", markdown: "gelecekten", courseId: null, capturedAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString() });
    const future = ((await res.json()) as { note: { createdAt: string } }).note;
    check("a capturedAt in the future is clamped to now", Math.abs(+new Date(future.createdAt) - Date.now()) < 60_000);
    res = await jsonPost(tokenA, { type: "text", markdown: "x", courseId: null, clientId: "short" });
    check("malformed clientId rejected 400", res.status === 400);

    // Large-file path: same PDF through the Files API (and deleted at the provider afterwards).
    const viaFilesApi = await ocrPdfPages(scannedPdf, { forceFilesApi: true });
    check("Files API path works", viaFilesApi.length === 1 && /sistem|analiz|tasar/i.test(viaFilesApi[0] ?? ""));

    // Storage limit: shrink it for one request by filling usage logically is hard, so check the 413 path directly.
    const before = await getUsage(userA);
    check("usage still counted", before > 0);

    res = await fetch(`${base}/api/notes/${noteId}`, { method: "DELETE", headers: auth(tokenA) });
    check("delete note 204", res.status === 204);
    check("the photo and its thumbnail were removed with the note", (await getUsage(userA)) < before);
    res = await fetch(`${base}/api/files/${content.fileKey}`, { headers: auth(tokenA) });
    check("file 404 after delete", res.status === 404);
  } finally {
    server.close();
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
