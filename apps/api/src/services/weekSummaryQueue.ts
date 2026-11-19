import { WeekSummaryModel } from "../models";
import { MAX_ATTEMPTS, MAX_DEFERRALS, MAX_UNAVAILABLE_DEFERRALS, unavailableDelayMs } from "./queue";

// Third queue lane (same rules as the processing and suggestion lanes): "write the summary of this week".
// The job lives on the WeekSummary document. It is only ever queued when the week page is opened and the
// summary is missing or stale, so weeks nobody opens cost no Gemini call.

const LEASE_MS = 3 * 60_000;
const BACKOFF_MS = 30_000;
const QUOTA_DELAY_MS = 60_000;
/** After a job gave up, opening the page does not queue another one for this long (the refresh button does). */
export const FAILED_COOLDOWN_MS = 10 * 60_000;

const isDuplicateKey = (err: unknown) => (err as { code?: number } | null)?.code === 11000;

/**
 * Queues a summary job unless one is already waiting/running (so opening the page again and again never
 * stacks jobs) or the last one just failed (unless `force`). Returns true when a job was queued.
 * Race-safe: a conflicting concurrent upsert hits the unique index and is treated as "already queued".
 */
export async function enqueueWeekSummary(
  userId: string,
  courseId: unknown,
  weekNo: number,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const cooldown = opts.force ? {} : { $or: [{ "job.failedAt": { $exists: false } }, { "job.failedAt": { $lt: new Date(Date.now() - FAILED_COOLDOWN_MS) } }] };
  try {
    const res = await WeekSummaryModel.updateOne(
      { userId, courseId, weekNo, "job.state": { $nin: ["pending", "processing"] }, ...cooldown },
      {
        $set: { "job.state": "pending", "job.attempts": 0, "job.deferrals": 0, "job.runAt": new Date() },
        $unset: { "job.leaseUntil": "", "job.lastError": "" },
        $setOnInsert: { summary: "", noteIds: [], stale: true },
      },
      { upsert: true },
    );
    return res.modifiedCount > 0 || res.upsertedCount > 0;
  } catch (err) {
    if (isDuplicateKey(err)) return false; // the document exists and does not match: a job is queued/running or cooling down
    throw err;
  }
}

export async function claimNextWeekSummary(extraFilter: Record<string, unknown> = {}) {
  const now = new Date();
  return WeekSummaryModel.findOneAndUpdate(
    {
      ...extraFilter,
      "job.attempts": { $lt: MAX_ATTEMPTS },
      $or: [
        { "job.state": "pending", "job.runAt": { $lte: now } },
        { "job.state": "processing", "job.leaseUntil": { $lt: now } },
      ],
    },
    // stale:false marks "built from the notes as they are now"; a note that changes meanwhile sets it true again.
    { $set: { "job.state": "processing", "job.leaseUntil": new Date(now.getTime() + LEASE_MS), stale: false }, $inc: { "job.attempts": 1 } },
    { sort: { "job.runAt": 1 }, new: true },
  );
}

export type ClaimedWeekSummary = NonNullable<Awaited<ReturnType<typeof claimNextWeekSummary>>>;

const owned = (s: ClaimedWeekSummary) => ({ _id: s._id, "job.state": "processing", "job.leaseUntil": s.job?.leaseUntil });

export async function completeWeekSummary(s: ClaimedWeekSummary, result: { summary: string; noteIds: unknown[] }): Promise<boolean> {
  const res = await WeekSummaryModel.updateOne(owned(s), {
    $set: { summary: result.summary, noteIds: result.noteIds, generatedAt: new Date(), "job.state": "done" },
    $unset: { "job.leaseUntil": "", "job.lastError": "", "job.failedAt": "" },
  });
  return res.modifiedCount > 0;
}

/** Gave up: the old summary (if any) stays, `stale` is true again and the page retries after the cooldown. */
const giveUp = (errorCode: string) => ({
  $set: { "job.state": "failed", "job.lastError": errorCode, "job.failedAt": new Date(), stale: true },
  $unset: { "job.leaseUntil": "" },
});

export async function failWeekSummary(s: ClaimedWeekSummary, errorCode: string): Promise<void> {
  const attempts = s.job?.attempts ?? MAX_ATTEMPTS;
  await WeekSummaryModel.updateOne(
    owned(s),
    attempts >= MAX_ATTEMPTS
      ? giveUp(errorCode)
      : {
          $set: { "job.state": "pending", "job.lastError": errorCode, "job.runAt": new Date(Date.now() + BACKOFF_MS * attempts) },
          $unset: { "job.leaseUntil": "" },
        },
  );
}

/** Quota (429) or overloaded model (500/503): wait without using an attempt, bounded like the other lanes. */
export async function deferWeekSummary(s: ClaimedWeekSummary, reason: "quota" | "unavailable" = "quota"): Promise<void> {
  const deferrals = s.job?.deferrals ?? 0;
  const unavailable = reason === "unavailable";
  if (deferrals + 1 > (unavailable ? MAX_UNAVAILABLE_DEFERRALS : MAX_DEFERRALS)) {
    await WeekSummaryModel.updateOne(owned(s), giveUp(unavailable ? "AI_UNAVAILABLE" : "QUOTA_EXHAUSTED"));
    return;
  }
  const delay = unavailable ? unavailableDelayMs(deferrals) : QUOTA_DELAY_MS;
  await WeekSummaryModel.updateOne(owned(s), {
    $set: { "job.state": "pending", "job.lastError": unavailable ? "AI_UNAVAILABLE" : "QUOTA", "job.runAt": new Date(Date.now() + delay) },
    $inc: { "job.attempts": -1, "job.deferrals": 1 },
    $unset: { "job.leaseUntil": "" },
  });
}

export async function sweepWeekSummaries(): Promise<void> {
  await WeekSummaryModel.updateMany(
    { "job.state": "processing", "job.leaseUntil": { $lt: new Date() }, "job.attempts": { $gte: MAX_ATTEMPTS } },
    giveUp("LEASE_EXPIRED"),
  );
}
