import type { ActiveSemesterResponse } from "@notkocu/shared";
import { CourseModel, SemesterModel, SessionModel } from "../models";

/** Active semester of the user with its courses and sessions (always scoped by userId). */
export async function loadActiveSemester(userId: string): Promise<ActiveSemesterResponse> {
  const semester = await SemesterModel.findOne({ userId, isActive: true }).lean();
  if (!semester) return { semester: null, courses: [] };

  const courses = await CourseModel.find({ userId, semesterId: semester._id }).sort({ _id: 1 }).lean();
  const sessions = await SessionModel.find({ userId, courseId: { $in: courses.map((c) => c._id) } })
    .sort({ day: 1, start: 1 })
    .lean();

  // lean() documents carry ObjectId/Date; JSON serialization turns them into strings
  // that match the shared types, so the cast only bridges that representation gap.
  return JSON.parse(
    JSON.stringify({
      semester,
      courses: courses.map((c) => ({
        ...c,
        sessions: sessions.filter((s) => s.courseId.equals(c._id)),
      })),
    }),
  ) as ActiveSemesterResponse;
}
