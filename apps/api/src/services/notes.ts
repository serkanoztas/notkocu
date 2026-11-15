import mongoose from "mongoose";
import { resolveAutoTarget, type AssignmentTarget, type NoteItem } from "@notkocu/shared";
import { CourseModel, SemesterModel, WeekSummaryModel } from "../models";
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
  return JSON.parse(JSON.stringify(doc)) as NoteItem;
}

export const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);
