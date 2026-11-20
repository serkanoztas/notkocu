import mongoose from "mongoose";
import { resolveAutoTarget, sessionDateTime, type AssignmentTarget, type NoteItem } from "@notkocu/shared";
import { CourseModel, SemesterModel, SessionModel, UserModel, WeekSummaryModel } from "../models";
import { AppError } from "../utils/AppError";
import { loadActiveContext } from "./semesters";

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** Malformed ids are treated like missing records: always 404, never a 400/500 that leaks anything. */
export function assertId(id: string | undefined): string {
  if (!id || !OBJECT_ID.test(id)) throw new AppError(404, "Kayıt bulunamadı", "NOT_FOUND");
  return id;
}

/** Server-side auto-assignment for a note created at `now` (shared rule, user's time zone). */
export async function autoAssign(userId: string, now: Date): Promise<AssignmentTarget | null> {
  const { timeZone, semester, sessions } = await loadActiveContext(userId);
  if (!semester) return null;
  return resolveAutoTarget(
    { startDate: semester.startDate.toISOString(), weekCount: semester.weekCount },
    sessions.map((s) => ({
      _id: String(s._id),
      courseId: String(s.courseId),
      day: s.day,
      start: s.start,
      end: s.end,
    })),
    now,
    timeZone,
  );
}

/** A manual target must be the user's own course and a week inside that course's semester. */
export async function assertManualTarget(userId: string, courseId: string, weekNo: number): Promise<void> {
  assertId(courseId);
  const course = await CourseModel.findOne({ _id: courseId, userId }).select("semesterId").lean();
  if (!course) throw new AppError(404, "Ders bulunamadı", "NOT_FOUND");
  const semester = await SemesterModel.findOne({ _id: course.semesterId, userId }).select("weekCount").lean();
  if (!semester || weekNo < 1 || weekNo > semester.weekCount) {
    throw new AppError(400, "Geçersiz hafta", "INVALID_WEEK");
  }
}

/**
 * Where an imported audio file goes. No auto-assignment: inbox unless the user picked a course + week.
 * A picked lesson dates the note by its session (the only session of the course, or the one the user chose
 * when there are several); a course without sessions keeps the import moment.
 */
export async function importPlacement(
  userId: string,
  want: { courseId?: string | null; weekNo?: number; sessionId?: string },
): Promise<{ target: { courseId: string; weekNo: number; sessionId?: string } | null; capturedAt?: Date }> {
  if (!want.courseId) return { target: null };
  if (want.weekNo === undefined) throw new AppError(400, "weekNo gerekli", "VALIDATION_ERROR");
  await assertManualTarget(userId, want.courseId, want.weekNo);
  const course = await CourseModel.findOne({ _id: want.courseId, userId }).select("semesterId").lean();
  const [semester, sessions, user] = await Promise.all([
    SemesterModel.findOne({ _id: course!.semesterId, userId }).select("startDate").lean(),
    SessionModel.find({ userId, courseId: want.courseId }).sort({ day: 1, start: 1 }).lean(),
    UserModel.findById(userId).select("timeZone").lean(),
  ]);
  let session = sessions.length === 1 ? sessions[0] : undefined;
  if (sessions.length > 1) {
    if (!want.sessionId) throw new AppError(400, "Bu dersin birden fazla oturumu var, oturum seç", "SESSION_REQUIRED");
    session = sessions.find((s) => String(s._id) === want.sessionId);
    if (!session) throw new AppError(400, "Geçersiz oturum", "INVALID_SESSION");
  }
  const target = { courseId: want.courseId, weekNo: want.weekNo, ...(session ? { sessionId: String(session._id) } : {}) };
  if (!session || !semester) return { target };
  const capturedAt = sessionDateTime({ startDate: semester.startDate.toISOString() }, session, want.weekNo, user?.timeZone);
  return { target, capturedAt };
}

/** The week summary of each touched (course, week) needs regenerating. No-op until summaries exist (stage 5). */
export async function markWeeksStale(
  userId: string,
  targets: ({ courseId?: unknown; weekNo?: number | null } | null)[],
): Promise<void> {
  const unique = new Map<string, { courseId: unknown; weekNo: number }>();
  for (const t of targets) {
    if (t?.courseId && t.weekNo) {
      unique.set(`${String(t.courseId)}:${t.weekNo}`, { courseId: t.courseId, weekNo: t.weekNo });
    }
  }
  await Promise.all(
    [...unique.values()].map((t) =>
      WeekSummaryModel.updateOne({ userId, courseId: t.courseId, weekNo: t.weekNo }, { stale: true }),
    ),
  );
}

/** First line of the text, trimmed to a title (used when the user leaves it empty). */
export function titleFromMarkdown(markdown: string): string {
  const first = markdown.split("\n").find((l) => l.trim()) ?? "";
  const clean = first.replace(/^[#>\-*\s]+/, "").trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean || "Adsız not";
}

/** Document/lean object -> API shape (ObjectId/Date become strings, matching the shared types). */
export function serializeNote(doc: unknown): NoteItem {
  const note = JSON.parse(JSON.stringify(doc)) as NoteItem & {
    job?: { budgetDeferred?: boolean };
    suggestJob?: { state?: string };
  };
  // Audio waiting for tomorrow's daily budget ("Sırada, yarın işlenecek").
  if (note.job?.budgetDeferred && note.status === "pending") note.budgetDeferred = true;
  // Queue bookkeeping stays on the server; the app only learns whether a suggestion is still being prepared.
  if (note.suggestJob) {
    note.suggesting = note.suggestJob.state === "pending" || note.suggestJob.state === "processing";
  }
  delete note.job;
  delete note.suggestJob;
  return note;
}

export const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);
