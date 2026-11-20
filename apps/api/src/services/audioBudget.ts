import { DEFAULT_TIME_ZONE, localDateKey, startOfNextLocalDay } from "@notkocu/shared";
import { env } from "../config/env";
import { AudioUsageModel, NoteItemModel, UserModel } from "../models";
import type { ClaimedNote } from "./queue";

// Per-user daily budget of audio minutes the worker transcribes (AUDIO_DAILY_BUDGET_MIN), counted per LOCAL
// day of the user. A note charges its whole length once, the first time the worker picks it up; a retry does
// not charge again (job.budgetDay). Over budget -> the note waits for the start of the user's next day.

export type BudgetDecision = { ok: true } | { ok: false; retryAt: Date };

export async function reserveAudioBudget(note: ClaimedNote, durationSec: number, now = new Date()): Promise<BudgetDecision> {
  if (note.job?.budgetDay) return { ok: true }; // charged by an earlier attempt
  const user = await UserModel.findById(note.userId).select("timeZone").lean();
  const timeZone = user?.timeZone ?? DEFAULT_TIME_ZONE;
  const day = localDateKey(now, timeZone);
  const budgetSec = env.AUDIO_DAILY_BUDGET_MIN * 60;
  const cost = Math.max(1, Math.round(durationSec));

  // Charge only while the day still has room. A single recording longer than the whole budget (misconfiguration)
  // is allowed on a day with no usage, so it can never wait forever.
  const room = Math.max(0, budgetSec - cost);
  try {
    await AudioUsageModel.findOneAndUpdate(
      { userId: note.userId, day, seconds: { $lte: room } },
      { $inc: { seconds: cost } },
      { upsert: true },
    );
  } catch (err) {
    // The filter failed, so the upsert tried to insert the (userId, day) row that already exists: over budget.
    if ((err as { code?: number }).code === 11000) return { ok: false, retryAt: startOfNextLocalDay(now, timeZone) };
    throw err;
  }
  await NoteItemModel.updateOne({ _id: note._id, status: "processing" }, { $set: { "job.budgetDay": day } });
  note.set("job.budgetDay", day);
  return { ok: true };
}
