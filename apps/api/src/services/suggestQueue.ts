import { NoteItemModel } from "../models";
import { MAX_ATTEMPTS, MAX_DEFERRALS } from "./queue";

// Queue lane for course suggestions (see NoteItem.suggestJob). Same rules as the processing lane
// (atomic claim with a lease, 3 attempts with backoff, quota waits do not use up attempts), but it
// ends in "done" whether or not a suggestion was found: a failure is silent, the user just picks the course.

const LEASE_MS = 2 * 60_000;
const BACKOFF_MS = 30_000;
const QUOTA_DELAY_MS = 60_000;

/** Puts an inbox note in line for a suggestion (no-op when it has none to read, already has one or is queued). */
export async function enqueueSuggest(noteId: unknown): Promise<void> {
  await NoteItemModel.updateOne(
    {
      _id: noteId,
      courseId: null,
      extractedText: { $exists: true, $nin: ["", null] },
      suggestion: { $exists: false },
      "suggestJob.state": { $nin: ["pending", "processing"] },
    },
    { $set: { suggestJob: { state: "pending", attempts: 0, deferrals: 0, runAt: new Date() } } },
  );
}

export async function claimNextSuggest(extraFilter: Record<string, unknown> = {}) {
  const now = new Date();
  return NoteItemModel.findOneAndUpdate(
    {
      ...extraFilter,
      courseId: null,
      "suggestJob.attempts": { $lt: MAX_ATTEMPTS },
      $or: [
        { "suggestJob.state": "pending", "suggestJob.runAt": { $lte: now } },
        { "suggestJob.state": "processing", "suggestJob.leaseUntil": { $lt: now } },
      ],
    },
    { $set: { "suggestJob.state": "processing", "suggestJob.leaseUntil": new Date(now.getTime() + LEASE_MS) }, $inc: { "suggestJob.attempts": 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
}

export type ClaimedSuggest = NonNullable<Awaited<ReturnType<typeof claimNextSuggest>>>;

const owned = (note: ClaimedSuggest) => ({
  _id: note._id,
  "suggestJob.state": "processing",
  "suggestJob.leaseUntil": note.suggestJob?.leaseUntil,
});

/** Finishes the job; the suggestion is only stored while the note is still in the inbox. */
export async function completeSuggest(
  note: ClaimedSuggest,
  suggestion: { courseId: string; weekNo: number; confidence: number } | null,
): Promise<void> {
  const res = await NoteItemModel.updateOne(
    { ...owned(note), courseId: null },
    {
      $set: { "suggestJob.state": "done", ...(suggestion ? { suggestion } : {}) },
      $unset: { "suggestJob.leaseUntil": "", "suggestJob.lastError": "" },
    },
  );
  if (res.matchedCount === 0) {
    // Moved out of the inbox while we worked: just close the job, store nothing.
    await NoteItemModel.updateOne(owned(note), { $set: { "suggestJob.state": "done" }, $unset: { "suggestJob.leaseUntil": "" } });
  }
}

export async function failSuggest(note: ClaimedSuggest, errorCode: string): Promise<void> {
  const attempts = note.suggestJob?.attempts ?? MAX_ATTEMPTS;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await NoteItemModel.updateOne(owned(note), {
    $set: giveUp
      ? { "suggestJob.state": "done", "suggestJob.lastError": errorCode }
      : { "suggestJob.state": "pending", "suggestJob.lastError": errorCode, "suggestJob.runAt": new Date(Date.now() + BACKOFF_MS * attempts) },
    $unset: { "suggestJob.leaseUntil": "" },
  });
}

/** Provider quota (429): wait ~60 s without using an attempt (bounded by MAX_DEFERRALS). */
export async function deferSuggest(note: ClaimedSuggest): Promise<void> {
  if ((note.suggestJob?.deferrals ?? 0) + 1 > MAX_DEFERRALS) {
    await NoteItemModel.updateOne(owned(note), {
      $set: { "suggestJob.state": "done", "suggestJob.lastError": "QUOTA_EXHAUSTED" },
      $unset: { "suggestJob.leaseUntil": "" },
    });
    return;
  }
  await NoteItemModel.updateOne(owned(note), {
    $set: { "suggestJob.state": "pending", "suggestJob.lastError": "QUOTA", "suggestJob.runAt": new Date(Date.now() + QUOTA_DELAY_MS) },
    $inc: { "suggestJob.attempts": -1, "suggestJob.deferrals": 1 },
    $unset: { "suggestJob.leaseUntil": "" },
  });
}

export async function sweepSuggest(): Promise<void> {
  await NoteItemModel.updateMany(
    { "suggestJob.state": "processing", "suggestJob.leaseUntil": { $lt: new Date() }, "suggestJob.attempts": { $gte: MAX_ATTEMPTS } },
    { $set: { "suggestJob.state": "done", "suggestJob.lastError": "LEASE_EXPIRED" }, $unset: { "suggestJob.leaseUntil": "" } },
  );
}
