import { NoteItemModel } from "../models";

// MongoDB-backed job queue: a note with status "pending" is a job. The worker claims it atomically
// (findOneAndUpdate -> "processing" with a lease), and either finishes it ("ready"), retries it
// (back to "pending" with a later runAt) or gives up ("failed") after MAX_ATTEMPTS.

export const MAX_ATTEMPTS = 3;
export const MAX_DEFERRALS = 30; // ~30 min of quota waiting, then give up
const LEASE_MS = 3 * 60_000;
const BACKOFF_MS = 30_000;
const QUOTA_DELAY_MS = 60_000;
// Overloaded model (500/503): start short, grow, give up after 10 deferrals (~30 min in total).
export const MAX_UNAVAILABLE_DEFERRALS = 10;
const UNAVAILABLE_BASE_MS = 10_000;
const UNAVAILABLE_MAX_MS = 5 * 60_000;
/** Delay before the next try, given how many deferrals the job already had: 10 s, 20 s, 40 s ... capped at 5 min. */
export const unavailableDelayMs = (deferrals: number) => Math.min(UNAVAILABLE_BASE_MS * 2 ** deferrals, UNAVAILABLE_MAX_MS);

/** Types the worker knows how to process. */
const HANDLED_TYPES = ["image", "document", "audio"];

/** Atomically takes the next due job (or an expired lease). Returns the note with job.attempts already counted. */
export async function claimNext(extraFilter: Record<string, unknown> = {}) {
  const now = new Date();
  return NoteItemModel.findOneAndUpdate(
    {
      ...extraFilter,
      type: { $in: HANDLED_TYPES },
      "job.attempts": { $lt: MAX_ATTEMPTS },
      $or: [
        { status: "pending", "job.runAt": { $lte: now } },
        { status: "processing", "job.leaseUntil": { $lt: now } }, // worker died mid-job
      ],
    },
    {
      $set: { status: "processing", "job.leaseUntil": new Date(now.getTime() + LEASE_MS) },
      $inc: { "job.attempts": 1 },
      $unset: { "job.budgetDeferred": "" },
    },
    { sort: { createdAt: 1 }, new: true },
  );
}

/** Expired leases that already used all attempts: nothing will ever pick them up, so fail them. */
export async function sweepExhausted(): Promise<number> {
  const res = await NoteItemModel.updateMany(
    { status: "processing", "job.leaseUntil": { $lt: new Date() }, "job.attempts": { $gte: MAX_ATTEMPTS } },
    { $set: { status: "failed", "job.lastError": "LEASE_EXPIRED" }, $unset: { "job.leaseUntil": "" } },
  );
  return res.modifiedCount;
}

export type ClaimedNote = NonNullable<Awaited<ReturnType<typeof claimNext>>>;

/** A write only applies while this worker still holds the lease; otherwise the result is dropped. */
const owned = (note: ClaimedNote) => ({ _id: note._id, status: "processing", "job.leaseUntil": note.job?.leaseUntil });

export async function complete(
  note: ClaimedNote,
  result: { extractedText: string; aiSummary: string; set?: Record<string, unknown> },
): Promise<boolean> {
  const res = await NoteItemModel.updateOne(owned(note), {
    $set: { status: "ready", extractedText: result.extractedText, aiSummary: result.aiSummary, ...result.set },
    $unset: { "job.leaseUntil": "", "job.lastError": "", "job.progress": "" },
  });
  return res.modifiedCount > 0;
}

/**
 * Long jobs (audio): stores one finished step and pushes the lease out again. Throws when this worker no longer
 * holds the lease (another one took the job), so the stale worker stops instead of overwriting.
 */
export async function saveProgress(note: ClaimedNote, key: string, value: unknown): Promise<void> {
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const res = await NoteItemModel.updateOne(owned(note), { $set: { ["job.progress." + key]: value, "job.leaseUntil": leaseUntil } });
  if (res.modifiedCount === 0) throw new LeaseLostError();
  note.set("job.leaseUntil", leaseUntil);
}

/** Pushes the lease out before a long step (upload, one big Gemini request). Throws when the lease is already lost. */
export async function extendLease(note: ClaimedNote): Promise<void> {
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const res = await NoteItemModel.updateOne(owned(note), { $set: { "job.leaseUntil": leaseUntil } });
  if (res.modifiedCount === 0) throw new LeaseLostError();
  note.set("job.leaseUntil", leaseUntil);
}

export class LeaseLostError extends Error {
  constructor() {
    super("LEASE_LOST");
    this.name = "LeaseLostError";
  }
}

/** Normal failure: retry with backoff, or fail for good after MAX_ATTEMPTS. */
export async function fail(note: ClaimedNote, errorCode: string): Promise<void> {
  const attempts = note.job?.attempts ?? MAX_ATTEMPTS;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await NoteItemModel.updateOne(owned(note), {
    $set: giveUp
      ? { status: "failed", "job.lastError": errorCode }
      : { status: "pending", "job.lastError": errorCode, "job.runAt": new Date(Date.now() + BACKOFF_MS * attempts) },
    $unset: { "job.leaseUntil": "" },
  });
}

/**
 * Provider quota (429): wait ~60 s without using up an attempt (bounded by MAX_DEFERRALS).
 * Overloaded model (500/503): same, but 10 s first, growing, bounded by MAX_UNAVAILABLE_DEFERRALS.
 */
export async function defer(note: ClaimedNote, reason: "quota" | "unavailable" = "quota"): Promise<void> {
  const deferrals = note.job?.deferrals ?? 0;
  const unavailable = reason === "unavailable";
  if (deferrals + 1 > (unavailable ? MAX_UNAVAILABLE_DEFERRALS : MAX_DEFERRALS)) {
    await NoteItemModel.updateOne(owned(note), {
      $set: { status: "failed", "job.lastError": unavailable ? "AI_UNAVAILABLE" : "QUOTA_EXHAUSTED" },
      $unset: { "job.leaseUntil": "" },
    });
    return;
  }
  const delay = unavailable ? unavailableDelayMs(deferrals) : QUOTA_DELAY_MS;
  await NoteItemModel.updateOne(owned(note), {
    $set: { status: "pending", "job.lastError": unavailable ? "AI_UNAVAILABLE" : "QUOTA", "job.runAt": new Date(Date.now() + delay) },
    $inc: { "job.attempts": -1, "job.deferrals": 1 },
    $unset: { "job.leaseUntil": "" },
  });
}

/**
 * The user's daily audio budget is used up: back to pending until `runAt` (the start of their next day).
 * Unlike defer() this uses up neither an attempt nor a deferral, however many days it waits.
 */
export async function deferBudget(note: ClaimedNote, runAt: Date): Promise<void> {
  await NoteItemModel.updateOne(owned(note), {
    $set: { status: "pending", "job.runAt": runAt, "job.budgetDeferred": true },
    $inc: { "job.attempts": -1 },
    $unset: { "job.leaseUntil": "" },
  });
}

/** failed -> pending for the "Tekrar dene" button. Returns false when the note was not failed. */
export async function requeue(userId: string, noteId: string): Promise<boolean> {
  const res = await NoteItemModel.updateOne(
    { _id: noteId, userId, status: "failed" },
    {
      $set: { status: "pending", "job.attempts": 0, "job.deferrals": 0, "job.runAt": new Date() },
      $unset: { "job.leaseUntil": "", "job.lastError": "" },
    },
  );
  return res.modifiedCount > 0;
}
