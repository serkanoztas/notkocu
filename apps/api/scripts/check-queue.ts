// Manual check of the file + queue logic against the real database, using throw-away user ids.
// Run: npm run check-queue   (creates and removes its own data; needs MONGODB_URI)
import mongoose from "mongoose";
import sharp from "sharp";
import { env } from "../src/config/env";
import { NoteItemModel } from "../src/models";
import { deleteFiles, deleteUserFiles, getUsage, openFile, saveFile } from "../src/services/files";
import { processImage, sniffImageMime } from "../src/services/imageProcess";
import { claimNext, complete, defer, fail, requeue, sweepExhausted } from "../src/services/queue";
import { setupGemini } from "./lib/geminiMode";

setupGemini(); // this script never asks Gemini anything; the fake only guarantees that by default
let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures += 1;
}

const userA = new mongoose.Types.ObjectId().toHexString();
const userB = new mongoose.Types.ObjectId().toHexString();

/** Removes everything this script created. Also runs when the script is interrupted or timed out. */
async function cleanup() {
  await NoteItemModel.deleteMany({ userId: { $in: [userA, userB] } });
  await deleteUserFiles(userA);
  await deleteUserFiles(userB);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void cleanup().catch(() => undefined).finally(() => process.exit(130)));
}

async function newImageNote(userId: string) {
  return NoteItemModel.create({ userId, courseId: null, type: "image", title: "Fotoğraf", content: { fileKey: "x" }, status: "pending" });
}

async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  // claimNext takes any due image note, so never run this against a database with real jobs waiting.
  const waiting = await NoteItemModel.countDocuments({ type: "image", status: { $in: ["pending", "processing"] } });
  if (waiting > 0) throw new Error(`${waiting} real image job(s) are waiting; aborting`);
  try {
    // --- sharp + files ---
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#336699" } })
      .jpeg()
      .withMetadata({ orientation: 6 }) // EXIF: rotate 90 deg
      .toBuffer();
    check("sniff jpeg", sniffImageMime(big) === "image/jpeg");
    check("sniff rejects text", sniffImageMime(Buffer.from("hello world, not an image")) === null);
    const p = await processImage(big, "image/jpeg");
    check("long edge <= 2000", Math.max(p.width ?? 0, p.height ?? 0) <= 2000);
    check("EXIF rotation applied (portrait now)", (p.height ?? 0) > (p.width ?? 0));
    const tm = p.thumb ? await sharp(p.thumb).metadata() : null;
    check("thumbnail <= 200 px", !!tm && (tm.width ?? 999) <= 200 && (tm.height ?? 999) <= 200);
    const undecodable = await processImage(Buffer.from("not an image at all, heic stand-in"), "image/heic");
    check("undecodable -> original kept, no thumb", !undecodable.thumb && undecodable.mime === "image/heic");

    const idA = await saveFile(userA, p.main, { mime: "image/jpeg", filename: "image" });
    check("owner can open", !!(await openFile(userA, idA)));
    check("other user gets null", (await openFile(userB, idA)) === null);
    check("malformed id gets 404-ish", await openFile(userA, "nope").then(() => false, () => true));
    check("usage counts bytes", (await getUsage(userA)) === p.main.length);
    await deleteFiles(userB, [idA]);
    check("other user cannot delete", !!(await openFile(userA, idA)));
    await deleteFiles(userA, [idA]);
    check("owner delete works", (await openFile(userA, idA)) === null && (await getUsage(userA)) === 0);
    await saveFile(userA, p.main, { mime: "image/jpeg", filename: "a" });
    await saveFile(userA, p.main, { mime: "image/jpeg", filename: "b" });
    await deleteUserFiles(userA);
    check("deleteUserFiles empties usage", (await getUsage(userA)) === 0);

    // --- queue ---
    const n1 = await newImageNote(userA);
    const [c1, c2] = await Promise.all([claimNext(), claimNext()]);
    const claimed = [c1, c2].filter(Boolean);
    check("two concurrent claims -> exactly one wins this note", claimed.filter((c) => String(c!._id) === String(n1._id)).length === 1);
    const mine = claimed.find((c) => String(c!._id) === String(n1._id))!;
    check("claim sets processing + attempts 1", mine.status === "processing" && mine.job?.attempts === 1);

    await fail(mine, "AI_500");
    let doc = await NoteItemModel.findById(n1._id);
    check("1st failure -> pending, runAt in the future", doc?.status === "pending" && +doc.job!.runAt! > Date.now());
    check("not claimable before runAt", !(await claimNext().then((c) => c && String(c._id) === String(n1._id))));

    await NoteItemModel.updateOne({ _id: n1._id }, { "job.runAt": new Date(Date.now() - 1000) });
    const again = (await claimNext())!;
    await defer(again);
    doc = await NoteItemModel.findById(n1._id);
    check("quota defer: pending, attempts unchanged, ~60 s", doc?.status === "pending" && doc.job?.attempts === 1 && doc.job.deferrals === 1 && +doc.job.runAt! - Date.now() > 50_000);

    // expired lease gets taken back
    await NoteItemModel.updateOne({ _id: n1._id }, { status: "processing", "job.leaseUntil": new Date(Date.now() - 1000) });
    const reclaimed = (await claimNext())!;
    check("expired lease is reclaimed (attempts 2)", String(reclaimed._id) === String(n1._id) && reclaimed.job?.attempts === 2);

    // third failure gives up
    await NoteItemModel.updateOne({ _id: n1._id }, { "job.attempts": 3 });
    const last = await NoteItemModel.findById(n1._id);
    await fail(last as never, "AI_500");
    doc = await NoteItemModel.findById(n1._id);
    check("3 attempts -> failed", doc?.status === "failed");

    check("retry: failed -> pending, attempts 0", (await requeue(userB, String(n1._id))) === false && (await requeue(userA, String(n1._id))) === true);
    doc = await NoteItemModel.findById(n1._id);
    check("after retry pending/attempts 0", doc?.status === "pending" && doc.job?.attempts === 0);

    // complete + lost lease
    await NoteItemModel.updateOne({ _id: n1._id }, { "job.runAt": new Date(Date.now() - 1000) });
    const run = (await claimNext())!;
    await NoteItemModel.updateOne({ _id: n1._id }, { "job.leaseUntil": new Date(Date.now() + 999_999) }); // someone else re-leased it
    check("result dropped when lease was lost", (await complete(run, { extractedText: "t", aiSummary: "s" })) === false);
    await NoteItemModel.updateOne({ _id: n1._id }, { "job.leaseUntil": run.job!.leaseUntil });
    check("result saved with the lease", (await complete(run, { extractedText: "t", aiSummary: "s", set: { "content.ocrMarkdown": "# t" } })) === true);
    doc = await NoteItemModel.findById(n1._id);
    check("ready with ocrMarkdown", doc?.status === "ready" && (doc.content as { ocrMarkdown?: string }).ocrMarkdown === "# t");

    // sweep: expired lease + exhausted attempts
    const n2 = await newImageNote(userA);
    await NoteItemModel.updateOne({ _id: n2._id }, { status: "processing", "job.attempts": 3, "job.leaseUntil": new Date(Date.now() - 1000) });
    await sweepExhausted();
    check("sweep fails exhausted expired leases", (await NoteItemModel.findById(n2._id))?.status === "failed");
  } finally {
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
