// End-to-end check of the photo-note API over HTTP, with throw-away users (no Google login needed).
// Needs the worker running in another terminal (`npm run worker`) to see the note become "ready".
// Run: npm run check-http   (uses the real Gemini key for one small OCR call; cleans up after itself)
import type { Server } from "node:http";
import mongoose from "mongoose";
import sharp from "sharp";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { NoteItemModel } from "../src/models";
import { deleteUserFiles, getUsage } from "../src/services/files";
import { signAccessToken } from "../src/services/auth/tokens";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const userA = new mongoose.Types.ObjectId().toHexString();
const userB = new mongoose.Types.ObjectId().toHexString();

async function photoWithText() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="100%" height="100%" fill="white"/>
    <text x="40" y="100" font-size="56" font-family="Arial" fill="black">Veritabani Yonetimi</text>
    <text x="40" y="190" font-size="40" font-family="Arial" fill="black">1. Normalizasyon</text>
    <text x="40" y="260" font-size="40" font-family="Arial" fill="black">2. Indeksleme</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
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
    res = await fetch(`${base}/api/notes`, { method: "POST", headers: auth(tokenA), body: form(Buffer.alloc(11 * 1024 * 1024, 1), { type: "image", inbox: "1" }) });
    check("11 MB rejected 413", res.status === 413);

    res = await fetch(`${base}/api/me/storage`, { headers: auth(tokenA) });
    const storage = (await res.json()) as { usedBytes: number; limitBytes: number };
    check("storage usage", res.status === 200 && storage.usedBytes > 0 && storage.limitBytes === env.USER_STORAGE_LIMIT_MB * 1024 * 1024, JSON.stringify(storage));

    res = await fetch(`${base}/api/notes/${noteId}`, { method: "PATCH", headers: { ...auth(tokenA), "Content-Type": "application/json" }, body: JSON.stringify({ markdown: "x" }) });
    check("PATCH markdown on image -> 400", res.status === 400);
    res = await fetch(`${base}/api/notes/${noteId}/retry`, { method: "POST", headers: auth(tokenA) });
    check("retry on non-failed -> 409", res.status === 409);
    res = await fetch(`${base}/api/notes/${noteId}`, { headers: auth(tokenB) });
    check("other user cannot read the note", res.status === 404);

    // The worker (separate process) should finish the note.
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

    // Storage limit: shrink it for one request by filling usage logically is hard, so check the 413 path directly.
    const before = await getUsage(userA);
    check("usage still counted", before > 0);

    res = await fetch(`${base}/api/notes/${noteId}`, { method: "DELETE", headers: auth(tokenA) });
    check("delete note 204", res.status === 204);
    check("files removed with the note", (await getUsage(userA)) === 0);
    res = await fetch(`${base}/api/files/${content.fileKey}`, { headers: auth(tokenA) });
    check("file 404 after delete", res.status === 404);
  } finally {
    server.close();
    await NoteItemModel.deleteMany({ userId: { $in: [userA, userB] } });
    await deleteUserFiles(userA);
    await deleteUserFiles(userB);
    await mongoose.disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
