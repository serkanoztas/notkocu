import { useMemo } from "react";
import {
  dayIndex,
  resolveAutoTarget,
  semesterWeekNo,
  sessionState,
  type CourseWithSessions,
  type Semester,
  type Session,
  type SessionState,
} from "@notkocu/shared";
import { useActiveSemester } from "./useActiveSemester";
import { useTimeZone } from "./useNow";

export interface TodaySession {
  session: Session;
  course: CourseWithSessions;
  state: SessionState;
}

export interface ScheduleNow {
  semester: Semester | null;
  courses: CourseWithSessions[];
  weekNo: number | null;
  /** Today's sessions in time order (cached semester + shared time rules, so it works offline). */
  today: TodaySession[];
  ongoing: TodaySession | null;
  upcoming: TodaySession[];
  /** Where a note taken at `now` is auto-assigned; null = inbox. */
  autoTarget: { course: CourseWithSessions; weekNo: number } | null;
  isLoading: boolean;
}

/** Auto-assignment target at `now` (shared rule, user's time zone); null = inbox. */
export function findAutoTarget(
  semester: Semester | null,
  courses: CourseWithSessions[],
  now: Date,
  timeZone: string,
): { course: CourseWithSessions; weekNo: number } | null {
  if (!semester) return null;
  const target = resolveAutoTarget(
    semester,
    courses.flatMap((c) => c.sessions.map((s) => ({ ...s, courseId: c._id }))),
    now,
    timeZone,
  );
  const course = target ? courses.find((c) => c._id === target.courseId) : undefined;
  return target && course ? { course, weekNo: target.weekNo } : null;
}

/**
 * "What is happening now", derived on the device from the cached active semester with the
 * shared rules and the user's time zone, so it is correct offline and matches the server.
 */
export function useScheduleNow(now: Date): ScheduleNow {
  const q = useActiveSemester(true);
  const timeZone = useTimeZone();
  const semester = q.data?.semester ?? null;
  const courses = useMemo(() => q.data?.courses ?? [], [q.data]);

  return useMemo(() => {
    if (!semester) {
      return {
        semester: null,
        courses,
        weekNo: null,
        today: [],
        ongoing: null,
        upcoming: [],
        autoTarget: null,
        isLoading: q.isPending,
      };
    }
    const weekNo = semesterWeekNo(semester, now, timeZone);
    const day = dayIndex(now, timeZone);
    const today = courses
      .flatMap((course) =>
        course.sessions
          .filter((s) => s.day === day)
          .flatMap((session) => {
            const state = sessionState(session, now, timeZone);
            return state ? [{ session, course, state }] : [];
          }),
      )
      .sort((a, b) => a.session.start.localeCompare(b.session.start));

    return {
      semester,
      courses,
      weekNo,
      today,
      ongoing: today.find((t) => t.state === "ongoing") ?? null,
      upcoming: today.filter((t) => t.state === "upcoming"),
      autoTarget: findAutoTarget(semester, courses, now, timeZone),
      isLoading: q.isPending,
    };
  }, [semester, courses, now, timeZone, q.isPending]);
}
