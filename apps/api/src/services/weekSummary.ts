import type { WeekSummaryView } from "@notkocu/shared";
import { NoteItemModel, WeekSummaryModel } from "../models";
import { OcrError, QuotaError } from "./ai/errors";
import { buildWeekInput, summarizeWeek } from "./ai/weekSummary";
import { completeWeekSummary, deferWeekSummary, enqueueWeekSummary, failWeekSummary, type ClaimedWeekSummary } from "./weekSummaryQueue";

/** One summary job: read the week's ready notes, ask Gemini, store the text and which notes it came from. */
export async function processWeekSummary(s: ClaimedWeekSummary): Promise<void> {
  try {
    const notes = await NoteItemModel.find({ userId: s.userId, courseId: s.courseId, weekNo: s.weekNo, status: "ready" })
      .sort({ createdAt: 1 })
      .select("type title aiSummary extractedText")
      .lean();
    const { text, noteIds } = buildWeekInput(
      notes.map((n) => ({ id: String(n._id), type: n.type, title: n.title, aiSummary: n.aiSummary, extractedText: n.extractedText })),
    );
    // Nothing to summarize any more (notes deleted or moved): store an empty result, no model call.
    const summary = text ? await summarizeWeek(text) : "";
    await completeWeekSummary(s, { summary, noteIds });
  } catch (err) {
    if (err instanceof QuotaError) return deferWeekSummary(s, err.reason);
    const code = err instanceof OcrError ? err.code : "INTERNAL";
    if (!(err instanceof OcrError)) console.error("Week summary job failed:", (err as Error).message);
    return failWeekSummary(s, code);
  }
}

/**
 * What the week page shows. Opening the page is the trigger: when the week has something to summarize and the
 * summary is missing or stale, a job is queued (once; see enqueueWeekSummary). null = nothing to summarize.
 */
export async function weekSummaryView(
  userId: string,
  courseId: unknown,
  weekNo: number,
  hasReadyNotes: boolean,
  opts: { force?: boolean } = {},
): Promise<WeekSummaryView | null> {
  if (!hasReadyNotes) return null;
  const find = () => WeekSummaryModel.findOne({ userId, courseId, weekNo }).lean();
  let doc = await find();
  let queued = false;
  if (opts.force || !doc || doc.stale || !doc.generatedAt) {
    queued = await enqueueWeekSummary(userId, courseId, weekNo, opts);
    if (queued) doc = await find();
  }
  const state = doc?.job?.state;
  const has = !!doc?.generatedAt;
  return {
    summary: has ? doc!.summary : "",
    noteIds: has ? doc!.noteIds.map(String) : [],
    generatedAt: doc?.generatedAt?.toISOString(),
    stale: doc?.stale ?? true,
    generating: queued || state === "pending" || state === "processing",
  };
}
