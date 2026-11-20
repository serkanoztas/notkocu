// Manual check of the file + queue logic against the real database, using throw-away user ids.
// Run: npm run check-queue   (creates and removes its own data; needs MONGODB_URI)
import mongoose from "mongoose";
import sharp from "sharp";
import { env } from "../src/config/env";
import { semesterWeekNo } from "@notkocu/shared";
import { AudioUsageModel, CourseModel, NoteItemModel, SemesterModel, WeekSummaryModel } from "../src/models";
import { deleteFiles, deleteUserFiles, getUsage, openFile, saveFile } from "../src/services/files";
import { processImage, sniffImageMime } from "../src/services/imageProcess";
import { processAudio } from "../src/services/audioProcess";
import { pinnedAudioBytes, sweepExpiredAudio, unpinDeadline } from "../src/services/audioRetention";
import { claimNext, complete, defer, fail, requeue, sweepExhausted } from "../src/services/queue";
import { buildWeekInput } from "../src/services/ai/weekSummary";
import { markWeeksStale, serializeNote } from "../src/services/notes";
import { processSuggest } from "../src/services/suggest";
import { processWeekSummary, weekSummaryView } from "../src/services/weekSummary";
import { claimNextWeekSummary } from "../src/services/weekSummaryQueue";
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
  await WeekSummaryModel.deleteMany({ userId: { $in: [userA, userB] } });
  await AudioUsageModel.deleteMany({ userId: { $in: [userA, userB] } });
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

    // --- audio retention: expired + unpinned -> every piece deleted, transcript stays ---
    {
      const piece = async (n: number) =>
        saveFile(userA, Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), Buffer.alloc(n, 3)]), { mime: "audio/aac", filename: "r.aac" });
      const day = 24 * 3600 * 1000;
      const mk = async (over: { expires: number; pinned?: boolean; status?: string }) => {
        const keys = [await piece(100), await piece(200)];
        const note = await NoteItemModel.create({
          userId: userA,
          courseId: null,
          type: "audio",
          title: "Ders kaydı",
          status: over.status ?? "ready",
          extractedText: "Normalizasyon anlatıldı",
          aiSummary: "Özet",
          content: {
            durationSec: 900,
            audioExpiresAt: new Date(Date.now() + over.expires * day),
            pinned: over.pinned ?? false,
            transcript: [{ startSec: 5, endSec: 40, text: "Normalizasyon" }],
            chapters: [{ startSec: 0, title: "Giriş" }],
            chunks: [
              { fileKey: keys[0], startSec: 0, durationSec: 600, size: 107, mime: "audio/aac" },
              { fileKey: keys[1], startSec: 600, durationSec: 300, size: 207, mime: "audio/aac" },
            ],
          },
        });
        return { note, keys };
      };
      const expired = await mk({ expires: -1 });
      const pinned = await mk({ expires: -1, pinned: true });
      const fresh = await mk({ expires: 5 });
      const busy = await mk({ expires: -1, status: "processing" });
      const swept = await sweepExpiredAudio(mine);
      const ex = await NoteItemModel.findById(expired.note._id);
      const exc = ex?.content as { audioDeleted?: boolean; chunks?: { fileKey?: string; startSec: number; durationSec: number }[]; transcript?: unknown[]; chapters?: unknown[] };
      const gone = (await Promise.all(expired.keys.map((k) => openFile(userA, k)))).every((f) => f === null);
      check("retention: expired unpinned audio -> all pieces deleted", swept === 1 && gone && exc.audioDeleted === true);
      check("retention: note, transcript, chapters, summary and piece timing stay", ex?.status === "ready" && ex.aiSummary === "Özet" && exc.transcript?.length === 1 && exc.chapters?.length === 1 && exc.chunks?.length === 2 && exc.chunks[1]!.startSec === 600 && !exc.chunks[0]!.fileKey);
      const kept = await Promise.all([...pinned.keys, ...fresh.keys, ...busy.keys].map((k) => openFile(userA, k)));
      check("retention: pinned, not yet expired and still-processing audio are kept", kept.every((f) => f !== null) && (await sweepExpiredAudio(mine)) === 0);
      check("retention: pinned bytes counted (recordings kept forever)", (await pinnedAudioBytes(userA)) === 314);
      const t0 = new Date("2026-11-19T12:00:00Z");
      const soon = unpinDeadline(new Date(+t0 + 2 * day), t0);
      const later = unpinDeadline(new Date(+t0 + 20 * day), t0);
      check("unpin: at least 7 days left, or the old deadline if later", +soon === +t0 + 7 * day && +later === +t0 + 20 * day);
    }

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

      // --- weekly summary lane ---
      {
        const wk = 5;
        const where = { userId: userA, courseId: course._id, weekNo: wk };
        check("week summary: nothing ready -> no summary, no job", (await weekSummaryView(userA, course._id, wk, false)) === null && (await WeekSummaryModel.countDocuments(where)) === 0);
        const t1 = await NoteItemModel.create({ ...where, type: "text", title: "2NF örnekleri", status: "ready", extractedText: "İkinci normal form kısmi bağımlılıkları kaldırır.", content: { markdown: "x" } });
        const a1 = await NoteItemModel.create({ ...where, type: "audio", title: "Ders kaydı", status: "ready", aiSummary: "Hoca normalizasyonu ve quiz duyurusunu anlattı.", extractedText: "HAM-TRANSKRIPT ".repeat(500), content: { chunks: [] } });
        const v1 = await weekSummaryView(userA, course._id, wk, true);
        check("week summary: first open queues a job, shows 'generating'", v1?.generating === true && v1.summary === "" && (await WeekSummaryModel.countDocuments(where)) === 1);
        await weekSummaryView(userA, course._id, wk, true);
        await weekSummaryView(userA, course._id, wk, true);
        check("week summary: opening again does not queue again", (await WeekSummaryModel.countDocuments({ ...where, "job.state": "pending" })) === 1 && (await WeekSummaryModel.findOne(where))?.job?.attempts === 0);

        const input = buildWeekInput([
          { id: "t", type: "text", title: "2NF", extractedText: "metin", aiSummary: null },
          { id: "a", type: "audio", title: "Ders kaydı", aiSummary: "kayıt özeti", extractedText: "HAM-TRANSKRIPT" },
          { id: "e", type: "audio", title: "Boş ses", aiSummary: null, extractedText: "HAM-TRANSKRIPT" },
        ]);
        check("week summary input: audio contributes its summary, never the raw transcript", input.text.includes("kayıt özeti") && !input.text.includes("HAM-TRANSKRIPT") && input.noteIds.join() === "t,a");

        const callsBefore = gemini.calls();
        const job = (await claimNextWeekSummary(mine))!;
        await processWeekSummary(job);
        const done = await WeekSummaryModel.findOne(where);
        check("week summary: processed, sources are the notes that fed it", done?.job?.state === "done" && !!done.summary && done.stale === false && done.noteIds.map(String).sort().join() === [String(t1._id), String(a1._id)].sort().join() && gemini.calls() - callsBefore === 1);
        const v2 = await weekSummaryView(userA, course._id, wk, true);
        check("week summary: fresh summary is shown and not regenerated", v2?.generating === false && !!v2.summary && v2.stale === false && (await WeekSummaryModel.findOne(where))?.job?.state === "done");

        await markWeeksStale(userA, [{ courseId: course._id, weekNo: wk }]);
        const v3 = await weekSummaryView(userA, course._id, wk, true);
        check("week summary: stale -> queued again, old text stays visible", v3?.generating === true && v3.stale === true && !!v3.summary);
        const oldText = done!.summary;
        const keepFallback = env.GEMINI_FALLBACK_MODEL; // a fallback from .env would rescue the fake 503
        env.GEMINI_FALLBACK_MODEL = undefined;
        gemini.failModel(env.GEMINI_MODEL, 503);
        const again = (await claimNextWeekSummary(mine))!;
        await processWeekSummary(again);
        gemini.failModel(env.GEMINI_MODEL, undefined);
        let s = await WeekSummaryModel.findOne(where);
        check("week summary: 503 -> deferred (~10 s), attempt not used, old summary kept", s?.job?.state === "pending" && s.job.attempts === 0 && s.job.deferrals === 1 && s.summary === oldText && +s.job.runAt! - Date.now() < 15_000);
        await WeekSummaryModel.updateOne(where, { "job.runAt": new Date(Date.now() - 1000), "job.deferrals": 10 });
        env.GEMINI_FALLBACK_MODEL = undefined;
        gemini.failModel(env.GEMINI_MODEL, 503);
        await processWeekSummary((await claimNextWeekSummary(mine))!);
        gemini.failModel(env.GEMINI_MODEL, undefined);
        env.GEMINI_FALLBACK_MODEL = keepFallback;
        s = await WeekSummaryModel.findOne(where);
        check("week summary: deferral cap -> failed, stale again, old summary kept", s?.job?.state === "failed" && s.stale === true && s.summary === oldText);
        const cooled = await weekSummaryView(userA, course._id, wk, true);
        check("week summary: no new job during the cooldown after a failure", cooled?.generating === false && (await WeekSummaryModel.findOne(where))?.job?.state === "failed");
        const forced = await weekSummaryView(userA, course._id, wk, true, { force: true });
        check("week summary: refresh button queues anyway", forced?.generating === true);
      }

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

      // --- imported audio: ONE file, Files API once, one request (continued only when cut off), daily budget ---
      {
        const savedFallback = env.GEMINI_FALLBACK_MODEL;
        env.GEMINI_FALLBACK_MODEL = undefined;
        const wavKey = (userId = userA) => saveFile(userId, Buffer.concat([Buffer.from("RIFF....WAVEfmt "), Buffer.alloc(400, 5)]), { mime: "audio/wav", filename: "i.wav" });
        const importedNote = async (durationSec: number, userId = userA) =>
          NoteItemModel.create({
            userId,
            courseId: null,
            type: "audio",
            title: "İçe aktarılan ses",
            status: "pending",
            source: "import",
            content: {
              imported: true,
              durationSec,
              chunks: [{ fileKey: await wavKey(userId), startSec: 0, durationSec, size: 416, mime: "audio/wav" }],
            },
          });
        const transcriptOf = async (id: unknown) =>
          ((await NoteItemModel.findById(id))?.content as { transcript?: { startSec: number }[] } | undefined)?.transcript ?? [];

        // 1) a short recording: one request, with the model's own output limit; the upload is made once and deleted
        gemini.setOutputLimit(40000);
        gemini.setImportScript({ durationSec: 600, perResponse: 1000 });
        let files0 = gemini.filesCalls();
        let note = await importedNote(600);
        await processAudio((await claimNext({ _id: note._id }))!);
        let reqs = gemini.importRequests();
        let doc = await NoteItemModel.findById(note._id);
        check("import: one request for a recording that fits the output limit", reqs.length === 1 && reqs[0]!.after === -1);
        check("import: maxOutputTokens is the model's limit from models.get (not a small constant)", reqs[0]!.maxOutputTokens === 40000);
        check("import: Files API upload once, deleted when done", gemini.filesCalls().upload - files0.upload === 1 && gemini.filesCalls().delete - files0.delete === 1);
        check("import: ready, global transcript from 5 s, chapters + summary", doc?.status === "ready" && (await transcriptOf(note._id))[0]?.startSec === 5 && !!doc?.aiSummary);
        check("import: progress bookkeeping cleared", !(doc?.job as { progress?: unknown } | undefined)?.progress);

        // 2) cut off twice (JSON cut mid-segment): continued from the last complete time stamp, no duplicates, one upload
        gemini.setImportScript({ durationSec: 3000, perResponse: 40, cutJson: true });
        files0 = gemini.filesCalls();
        note = await importedNote(3000);
        await processAudio((await claimNext({ _id: note._id }))!);
        reqs = gemini.importRequests();
        const t2 = await transcriptOf(note._id);
        check("import: cut-off answers are continued after the last complete segment", JSON.stringify(reqs.map((r) => r.after)) === "[-1,1145,2315]");
        check("import: every segment exactly once, in order", t2.length === 100 && t2.every((s, i) => s.startSec === 5 + 30 * i));
        check("import: still one upload for all the requests", gemini.filesCalls().upload - files0.upload === 1 && gemini.filesCalls().delete - files0.delete === 1);

        // 3) a continuation fails (503): the retry resumes after the saved point, no new upload
        gemini.setImportScript({ durationSec: 3000, perResponse: 40, cutJson: true });
        files0 = gemini.filesCalls();
        note = await importedNote(3000);
        gemini.failOnCall(2, 503);
        const first = (await claimNext({ _id: note._id }))!;
        let threw = "";
        try {
          await processAudio(first);
        } catch (err) {
          threw = (err as Error).name;
        }
        const seg = ((await NoteItemModel.findById(note._id))?.job as { progress?: { seg?: { doneUntilSec: number; complete: boolean } } } | undefined)?.progress?.seg;
        check("import: request 1 saved before request 2 failed", threw === "QuotaError" && seg?.doneUntilSec === 1145 && seg.complete === false);
        check("import: the upload is kept for the retry", gemini.filesCalls().delete === files0.delete);
        await defer(first, "unavailable");
        await NoteItemModel.updateOne({ _id: note._id }, { "job.runAt": new Date(Date.now() - 1000) });
        await processAudio((await claimNext({ _id: note._id }))!);
        check("import: the retry continues from the saved point (no restart, no second upload)", JSON.stringify(gemini.importRequests().map((r) => r.after)) === "[-1,1145,2315]" && gemini.filesCalls().upload - files0.upload === 1);
        check("import: resumed transcript is complete and ordered", (await transcriptOf(note._id)).length === 100 && (await NoteItemModel.findById(note._id))?.status === "ready");
        env.GEMINI_FALLBACK_MODEL = savedFallback;

        // 4) daily budget (live and imported alike): the note over budget waits for the user's next day
        gemini.setImportScript({ durationSec: 200, perResponse: 1000 });
        const savedBudget = env.AUDIO_DAILY_BUDGET_MIN;
        env.AUDIO_DAILY_BUDGET_MIN = 5; // 300 s
        const budgetUser = new mongoose.Types.ObjectId().toHexString();
        try {
          const b1 = await importedNote(200, budgetUser);
          await processAudio((await claimNext({ _id: b1._id }))!);
          check("budget: first recording fits and is processed", (await NoteItemModel.findById(b1._id))?.status === "ready");
          const b2 = await importedNote(200, budgetUser);
          const claimed = (await claimNext({ _id: b2._id }))!;
          const callsBefore = gemini.calls();
          const processed = await processAudio(claimed);
          const d2 = await NoteItemModel.findById(b2._id);
          const wait = +(d2?.job?.runAt ?? 0) - Date.now();
          check("budget: over budget -> pending, waits for the user's next day, nothing sent to Gemini", processed === false && d2?.status === "pending" && wait > 0 && wait <= 24 * 3600 * 1000 && gemini.calls() === callsBefore);
          check("budget: waiting does not use up attempts or deferrals", (d2?.job?.attempts ?? 0) === 0 && (d2?.job?.deferrals ?? 0) === 0 && d2?.job?.budgetDeferred === true);
          check("budget: the app is told it is waiting for tomorrow", serializeNote(d2!.toJSON()).budgetDeferred === true);
          check("budget: not claimable before the next day", (await claimNext({ _id: b2._id })) === null);
          // a day later: the old day's ledger no longer counts
          await AudioUsageModel.deleteMany({ userId: budgetUser });
          await NoteItemModel.updateOne({ _id: b2._id }, { "job.runAt": new Date(Date.now() - 1000) });
          await processAudio((await claimNext({ _id: b2._id }))!);
          const d2b = await NoteItemModel.findById(b2._id);
          check("budget: next day it is processed by itself", d2b?.status === "ready" && !d2b.job?.budgetDeferred);
          // a retry of a charged note never charges twice
          const used = (await AudioUsageModel.findOne({ userId: budgetUser }))?.seconds;
          const b3 = await importedNote(100, budgetUser);
          await NoteItemModel.updateOne({ _id: b3._id }, { "job.budgetDay": "2000-01-01" });
          await processAudio((await claimNext({ _id: b3._id }))!);
          check("budget: a note charged by an earlier attempt is not charged again", (await AudioUsageModel.findOne({ userId: budgetUser }))?.seconds === used);
          // one recording longer than the whole budget is allowed on an unused day (never waits forever)
          await AudioUsageModel.deleteMany({ userId: budgetUser });
          const huge = await importedNote(400, budgetUser);
          await processAudio((await claimNext({ _id: huge._id }))!);
          check("budget: a recording longer than the whole budget still runs on an unused day", (await NoteItemModel.findById(huge._id))?.status === "ready");
        } finally {
          env.AUDIO_DAILY_BUDGET_MIN = savedBudget;
          await NoteItemModel.deleteMany({ userId: budgetUser });
          await AudioUsageModel.deleteMany({ userId: budgetUser });
          await deleteUserFiles(budgetUser);
        }

        // 5) skipped (too long) recordings are never claimed, and the 30-day sweep deletes their audio like any other
        const skippedKey = await wavKey();
        const skipped = await NoteItemModel.create({
          userId: userA,
          courseId: null,
          type: "audio",
          title: "Uzun kayıt",
          status: "skipped",
          content: { imported: true, durationSec: 9000, skipReason: "too_long", audioExpiresAt: new Date(Date.now() - 1000), pinned: false, chunks: [{ fileKey: skippedKey, startSec: 0, durationSec: 9000, size: 416, mime: "audio/wav" }] },
        });
        check("skipped: never claimed by the worker", (await claimNext({ _id: skipped._id })) === null);
        await sweepExpiredAudio(mine);
        const swept = await NoteItemModel.findById(skipped._id);
        check("skipped: the retention sweep deletes its audio", (swept?.content as { audioDeleted?: boolean }).audioDeleted === true && (await openFile(userA, skippedKey)) === null);
        gemini.setImportScript(undefined);
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
