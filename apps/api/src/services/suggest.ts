import { semesterWeekNo } from "@notkocu/shared";
import { OcrError, QuotaError } from "./ai/errors";
import { suggestCourse } from "./ai/courseSuggest";
import { loadActiveContext } from "./semesters";
import { completeSuggest, deferSuggest, failSuggest, type ClaimedSuggest } from "./suggestQueue";

/** Suggestions below this confidence are not stored; the user picks the course. */
export const SUGGEST_MIN_CONFIDENCE = 0.7;

/** One suggest job: ask Gemini for the course, compute the week from the note's date, store or drop. */
export async function processSuggest(note: ClaimedSuggest): Promise<void> {
  try {
    const userId = String(note.userId);
    const { timeZone, semester, courses } = await loadActiveContext(userId);
    const text = note.extractedText ?? "";

    // Nothing to suggest from, or no semester: close the job without calling the model.
    const when = note.capturedAt ?? note.createdAt;
    const weekNo = semester && when
      ? semesterWeekNo({ startDate: semester.startDate.toISOString(), weekCount: semester.weekCount }, when, timeZone)
      : null;
    if (!semester || !text.trim() || weekNo === null) return completeSuggest(note, null);

    const guess = await suggestCourse({
      title: note.title,
      text,
      courses: courses.map((c) => ({ id: String(c._id), code: c.code, name: c.name, instructor: c.instructor ?? undefined })),
    });
    if (!guess.courseId || guess.confidence < SUGGEST_MIN_CONFIDENCE) return completeSuggest(note, null);
    return completeSuggest(note, { courseId: guess.courseId, weekNo, confidence: guess.confidence });
  } catch (err) {
    if (err instanceof QuotaError) return deferSuggest(note);
    const code = err instanceof OcrError ? err.code : "INTERNAL";
    if (!(err instanceof OcrError)) console.error("Suggest job failed:", (err as Error).message);
    return failSuggest(note, code);
  }
}
