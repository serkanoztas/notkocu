// Manual check of the file + queue logic against the real database, using throw-away user ids.
// Run: npm run check-queue   (creates and removes its own data; needs MONGODB_URI)
import mongoose from "mongoose";
import sharp from "sharp";
import { env } from "../src/config/env";
import { semesterWeekNo } from "@notkocu/shared";
import { CourseModel, NoteItemModel, SemesterModel } from "../src/models";
import { deleteFiles, deleteUserFiles, getUsage, openFile, saveFile } from "../src/services/files";
import { processImage, sniffImageMime } from "../src/services/imageProcess";
import { processAudio } from "../src/services/audioProcess";
import { claimNext, complete, defer, fail, requeue, sweepExhausted } from "../src/services/queue";
import { processSuggest } from "../src/services/suggest";
import { claimNextSuggest, completeSuggest, deferSuggest, enqueueSuggest, failSuggest, sweepSuggest } from "../src/services/suggestQueue";
import { setupGemini } from "./lib/geminiMode";

// Queue and suggestion lanes only; with the fake (default) no real Gemini request is ever made.
const gemini = setupGemini();
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
  await CourseModel.deleteMany({ userId: { $in: [userA, userB] } });
  await SemesterModel.deleteMany({ userId: { $in: [userA, userB] } });
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
  const suggestWaiting = await NoteItemModel.countDocuments({ "suggestJob.state": { $in: ["pending", "processing"] } });
  if (suggestWaiting > 0) throw new Error(`${suggestWaiting} real suggestion job(s) are waiting; aborting`);
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

    // --- clientId unique index and createdAt override (database level; the HTTP side is in check-http) ---
    {
      await NoteItemModel.init(); // make sure the partial unique index exists
      const cid = `queue${Date.now().toString(36)}`;
      const when = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const make = (userId: string, clientId?: string) =>
        NoteItemModel.create({ userId, courseId: null, type: "text", title: "c", content: { markdown: "x" }, extractedText: "x", status: "ready", clientId, capturedAt: when, createdAt: when });
      const a = await make(userA, cid);
      check("createdAt can be set from capturedAt", Math.abs(+a.createdAt - +when) < 1000);
      const dup = await make(userA, cid).then(() => null, (e: { code?: number }) => e.code);
      check("same (userId, clientId) twice -> duplicate key error", dup === 11000);
      const otherUser = await make(userB, cid).then(() => true, () => false);
      check("same clientId for another user is fine", otherUser);
      const none = await Promise.all([make(userA), make(userA), make(userA)]).then(() => true, () => false);
      check("notes without a clientId are not limited", none);
    }

    // --- suggestion lane (own block: it reuses names of the queue checks above) ---
    {
    const mine = { userId: { $in: [userA, userB] } }; // the lane claim is limited to our own notes
    const textNote = (extra: Record<string, unknown> = {}) =>
      NoteItemModel.create({ userId: userA, courseId: null, type: "text", title: "Not", content: { markdown: "x" }, extractedText: "Normalizasyon ve indeksleme", status: "ready", ...extra });

    const s1 = await textNote();
    check("a text note is not a processing job", (await claimNext().then((c) => c && String(c._id) === String(s1._id))) !== true);
    await enqueueSuggest(s1._id);
    const s1doc = await NoteItemModel.findById(s1._id);
    check("enqueue: pending suggest job, status untouched", s1doc?.suggestJob?.state === "pending" && s1doc.status === "ready");

    const inCourse = await textNote({ courseId: new mongoose.Types.ObjectId(), weekNo: 2 });
    const hasSuggestion = await textNote({ suggestion: { courseId: new mongoose.Types.ObjectId(), weekNo: 1, confidence: 0.9 } });
    const empty = await textNote({ extractedText: "" });
    await Promise.all([inCourse, hasSuggestion, empty].map((n) => enqueueSuggest(n._id)));
    const queued = await NoteItemModel.countDocuments({ _id: { $in: [inCourse._id, hasSuggestion._id, empty._id] }, suggestJob: { $exists: true } });
    check("not enqueued: assigned, already suggested, or no text", queued === 0);

    const [g1, g2] = await Promise.all([claimNextSuggest(mine), claimNextSuggest(mine)]);
    const got = [g1, g2].filter(Boolean);
    check("two concurrent suggest claims: exactly one wins", got.length === 1 && String(got[0]!._id) === String(s1._id) && got[0]!.suggestJob?.attempts === 1);

    await failSuggest(got[0]!, "AI_500");
    let sj = (await NoteItemModel.findById(s1._id))?.suggestJob;
    check("1st suggest failure -> pending with backoff", sj?.state === "pending" && +sj.runAt! > Date.now());
    await NoteItemModel.updateOne({ _id: s1._id }, { "suggestJob.runAt": new Date(Date.now() - 1000) });
    const again = (await claimNextSuggest(mine))!;
    await deferSuggest(again);
    sj = (await NoteItemModel.findById(s1._id))?.suggestJob;
    check("quota defer: attempts unchanged, ~60 s", sj?.state === "pending" && sj.attempts === 1 && sj.deferrals === 1 && +sj.runAt! - Date.now() > 50_000);

    await NoteItemModel.updateOne({ _id: s1._id }, { "suggestJob.runAt": new Date(Date.now() - 1000), "suggestJob.attempts": 2 });
    const third = (await claimNextSuggest(mine))!;
    await failSuggest(third, "AI_500");
    const s1end = await NoteItemModel.findById(s1._id);
    check("3 failed attempts -> done silently, no suggestion", s1end?.suggestJob?.state === "done" && !s1end.suggestion);

    const s2 = await textNote();
    await enqueueSuggest(s2._id);
    const c2 = (await claimNextSuggest(mine))!;
    await completeSuggest(c2, { courseId: String(new mongoose.Types.ObjectId()), weekNo: 3, confidence: 0.85 });
    const stored = await NoteItemModel.findById(s2._id);
    check("suggestion stored, job done", stored?.suggestJob?.state === "done" && stored.suggestion?.weekNo === 3);

    const s3 = await textNote();
    await enqueueSuggest(s3._id);
    const c3 = (await claimNextSuggest(mine))!;
    await NoteItemModel.updateOne({ _id: s3._id }, { courseId: new mongoose.Types.ObjectId(), weekNo: 1 }); // user assigned it meanwhile
    await completeSuggest(c3, { courseId: String(new mongoose.Types.ObjectId()), weekNo: 3, confidence: 0.9 });
    const moved = await NoteItemModel.findById(s3._id);
    check("result dropped when the note left the inbox", moved?.suggestJob?.state === "done" && !moved.suggestion);

    const s4 = await textNote();
    await NoteItemModel.updateOne({ _id: s4._id }, { suggestJob: { state: "processing", attempts: 3, leaseUntil: new Date(Date.now() - 1000), runAt: new Date() } });
    await sweepSuggest();
    check("sweep closes exhausted expired suggest leases", (await NoteItemModel.findById(s4._id))?.suggestJob?.state === "done");

    // processSuggest end to end with a real semester/course and the fake model
    if (gemini) {
      const monday = new Date();
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      monday.setUTCHours(12, 0, 0, 0);
      const sem = await SemesterModel.create({ userId: userA, name: "T", startDate: monday, weekCount: 14, isActive: true });
      const course = await CourseModel.create({ userId: userA, semesterId: sem._id, code: "T-1", name: "Test dersi" });
      const week = semesterWeekNo({ startDate: monday.toISOString(), weekCount: 14 }, new Date());

      const p1 = await textNote();
      await enqueueSuggest(p1._id);
      await processSuggest((await claimNextSuggest(mine))!);
      let done = await NoteItemModel.findById(p1._id);
      check("processSuggest: course + week from the note date", String(done?.suggestion?.courseId) === String(course._id) && done?.suggestion?.weekNo === week && done?.suggestJob?.state === "done");

      // captured before the semester started: the week is outside it, so no suggestion (the AI never picks weeks)
      const old = await textNote({ capturedAt: new Date(monday.getTime() - 8 * 24 * 3600 * 1000) });
      await enqueueSuggest(old._id);
      await processSuggest((await claimNextSuggest(mine))!);
      done = await NoteItemModel.findById(old._id);
      check("processSuggest: capturedAt before the semester -> no suggestion", !done?.suggestion && done?.suggestJob?.state === "done");

      gemini.setSuggestConfidence(0.5);
      const low = await textNote();
      await enqueueSuggest(low._id);
      await processSuggest((await claimNextSuggest(mine))!);
      check("processSuggest: confidence 0.5 -> nothing stored", !(await NoteItemModel.findById(low._id))?.suggestion);
      gemini.setSuggestConfidence(0.9);

      gemini.failNextWith(429);
      const quota = await textNote();
      await enqueueSuggest(quota._id);
      await processSuggest((await claimNextSuggest(mine))!);
      const q = (await NoteItemModel.findById(quota._id))?.suggestJob;
      check("processSuggest: 429 -> deferred, attempt not used", q?.state === "pending" && q.attempts === 0 && q.deferrals === 1);

      // --- audio: a failed piece is the only one redone ---
      {
        const k0 = await saveFile(userA, Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), Buffer.alloc(300, 1)]), { mime: "audio/aac", filename: "a0.aac" });
        const k1 = await saveFile(userA, Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), Buffer.alloc(300, 2)]), { mime: "audio/aac", filename: "a1.aac" });
        const audio = await NoteItemModel.create({
          userId: userA,
          courseId: null,
          type: "audio",
          title: "Ders kaydı",
          status: "pending",
          content: {
            durationSec: 900,
            chunks: [
              { fileKey: k0, startSec: 0, durationSec: 600, size: 307, mime: "audio/aac" },
              { fileKey: k1, startSec: 600, durationSec: 300, size: 307, mime: "audio/aac" },
            ],
          },
        });
        const savedFallback = env.GEMINI_FALLBACK_MODEL;
        env.GEMINI_FALLBACK_MODEL = undefined;
        const callsBefore = gemini.calls();
        gemini.failOnCall(2, 503); // piece 0 works, piece 1 hits an overloaded model
        const first = (await claimNext({ _id: audio._id }))!;
        const lease0 = +first.job!.leaseUntil!;
        let threw = "";
        try {
          await processAudio(first);
        } catch (err) {
          threw = (err as Error).name;
        }
        let doc = await NoteItemModel.findById(audio._id);
        const progress = (doc?.job as { progress?: Record<string, unknown> } | undefined)?.progress ?? {};
        check("audio: piece 1 failed, piece 0 result is kept", threw === "QuotaError" && "0" in progress && !("1" in progress));
        check("audio: the lease was extended after the finished piece", +doc!.job!.leaseUntil! > lease0);
        await defer(first, "unavailable");
        await NoteItemModel.updateOne({ _id: audio._id }, { "job.runAt": new Date(Date.now() - 1000) });
        const callsMid = gemini.calls();
        const again = (await claimNext({ _id: audio._id }))!;
        check("audio: retry claim keeps the progress", "0" in ((again.job as { progress?: Record<string, unknown> }).progress ?? {}));
        await processAudio(again);
        doc = await NoteItemModel.findById(audio._id);
        const c = doc?.content as { transcript?: { startSec: number; endSec: number; text: string }[]; chapters?: { startSec: number; title: string }[] };
        check("audio: retry transcribed only piece 1 + chapters (2 calls)", gemini.calls() - callsMid === 2 && callsMid - callsBefore === 2);
        check("audio: ready, transcript on the global timeline", doc?.status === "ready" && JSON.stringify(c.transcript?.map((t) => t.startSec)) === "[5,40,605,640]");
        check("audio: segment ends run to the next segment / piece end", c.transcript?.[0]?.endSec === 40 && c.transcript?.[1]?.endSec === 600 && c.transcript?.[2]?.endSec === 640 && c.transcript?.[3]?.endSec === 900);
        check("audio: chapters + summary + extractedText filled", c.chapters?.length === 2 && !!doc?.aiSummary && /normal form/i.test(doc?.extractedText ?? ""));
        check("audio: progress bookkeeping cleared", !(doc?.job as { progress?: unknown } | undefined)?.progress);
        env.GEMINI_FALLBACK_MODEL = savedFallback;
      }

      // --- 503/500: fallback model, then deferral without using attempts ---
      const primary = env.GEMINI_MODEL;
      env.GEMINI_FALLBACK_MODEL = "fake-fallback-model";
      try {
        gemini.failModel(primary, 503);
        const before = gemini.models().length;
        const fb = await textNote();
        await enqueueSuggest(fb._id);
        await processSuggest((await claimNextSuggest(mine))!);
        const fbModels = gemini.models().slice(before);
        const fbDone = (await NoteItemModel.findById(fb._id))?.suggestJob;
        check("primary 503 -> same request retried once with the fallback model", fbModels.length === 2 && fbModels[0] === primary && fbModels[1] === "fake-fallback-model");
        check("primary 503 + fallback ok -> job completed, no deferral", fbDone?.state === "done" && !fbDone.deferrals);
        gemini.failModel(primary, undefined);

        gemini.failModel(primary, 500);
        const before500 = gemini.models().length;
        const fb500 = await textNote();
        await enqueueSuggest(fb500._id);
        await processSuggest((await claimNextSuggest(mine))!);
        check("primary 500 also falls back", gemini.models().slice(before500).join() === `${primary},fake-fallback-model` && (await NoteItemModel.findById(fb500._id))?.suggestJob?.state === "done");
        gemini.failModel(primary, undefined);

        gemini.failModel(primary, 503);
        gemini.failModel("fake-fallback-model", 503);
        const down = await textNote();
        await enqueueSuggest(down._id);
        await processSuggest((await claimNextSuggest(mine))!);
        let d = (await NoteItemModel.findById(down._id))?.suggestJob;
        const wait1 = +d!.runAt! - Date.now();
        check("both 503 -> deferred, attempts not increased, ~10 s first", d?.state === "pending" && d.attempts === 0 && d.deferrals === 1 && wait1 > 5_000 && wait1 < 15_000);
        await NoteItemModel.updateOne({ _id: down._id }, { "suggestJob.runAt": new Date(Date.now() - 1000) });
        await processSuggest((await claimNextSuggest(mine))!);
        d = (await NoteItemModel.findById(down._id))?.suggestJob;
        const wait2 = +d!.runAt! - Date.now();
        check("2nd deferral waits longer (~20 s), attempts still 0", d?.attempts === 0 && d.deferrals === 2 && wait2 > 15_000 && wait2 < 25_000);

        // after 10 deferrals the job gives up (suggest lane ends silently as "done")
        await NoteItemModel.updateOne({ _id: down._id }, { "suggestJob.runAt": new Date(Date.now() - 1000), "suggestJob.deferrals": 10 });
        await processSuggest((await claimNextSuggest(mine))!);
        d = (await NoteItemModel.findById(down._id))?.suggestJob;
        check("deferral cap (10) reached -> gives up", d?.state === "done" && d.lastError === "AI_UNAVAILABLE");

        // processing lane: same rules through queue.defer
        const img = await newImageNote(userA);
        const claimedImg = (await claimNext({ _id: img._id }))!;
        await defer(claimedImg, "unavailable");
        let nd = (await NoteItemModel.findById(img._id))?.job;
        check("processing lane: 503 defer -> pending, attempts back to 0, ~10 s", nd?.attempts === 0 && nd.deferrals === 1 && +nd.runAt! - Date.now() < 15_000);
        await NoteItemModel.updateOne({ _id: img._id }, { "job.runAt": new Date(Date.now() - 1000), "job.deferrals": 10 });
        await defer((await claimNext({ _id: img._id }))!, "unavailable");
        check("processing lane: deferral cap (10) -> failed AI_UNAVAILABLE", (await NoteItemModel.findById(img._id))?.status === "failed");
      } finally {
        gemini.failModel(primary, undefined);
        gemini.failModel("fake-fallback-model", undefined);
        env.GEMINI_FALLBACK_MODEL = undefined;
      }
    }
    }
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
