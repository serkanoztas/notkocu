// Note auto-assignment and "what is happening now" rules, shared by the API and the app
// so both give the same answer for the same user time zone.
// Built only on time.ts; never compute days / minutes / weeks anywhere else.

import {
  DEFAULT_TIME_ZONE,
  dayIndex,
  matchesSessionWindow,
  minutesOfDay,
  parseHHmm,
  weekNo,
  type SessionTime,
} from "./time";
import type { SessionState } from "./types";

export interface AssignableSession extends SessionTime {
  _id: string;
  courseId: string;
}

export interface AssignmentTarget {
  courseId: string;
  weekNo: number;
  sessionId: string;
}

/** Current week of the semester, or null when `now` is before it starts or after its last week. */
export function semesterWeekNo(
  semester: { startDate: string; weekCount: number },
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): number | null {
  const w = weekNo(new Date(semester.startDate), now, timeZone);
  return w >= 1 && w <= semester.weekCount ? w : null;
}

/**
 * Where a note taken at `now` goes: the session whose window (start - 10 min .. end + 30 min)
 * contains `now`, in the current semester week. null = inbox.
 * If several windows overlap, the session closest to `now` wins (one in progress beats one that
 * has not started or has ended; ties go to the earlier start).
 */
export function resolveAutoTarget(
  semester: { startDate: string; weekCount: number },
  sessions: AssignableSession[],
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): AssignmentTarget | null {
  const week = semesterWeekNo(semester, now, timeZone);
  if (week === null) return null;

  const minutes = minutesOfDay(now, timeZone);
  const distance = (s: SessionTime) => {
    const start = parseHHmm(s.start);
    const end = parseHHmm(s.end);
    return minutes < start ? start - minutes : minutes > end ? minutes - end : 0;
  };

  const best = sessions
    .filter((s) => matchesSessionWindow(s, now, timeZone))
    .sort((a, b) => distance(a) - distance(b) || parseHHmm(a.start) - parseHHmm(b.start))[0];
  return best ? { courseId: best.courseId, weekNo: week, sessionId: best._id } : null;
}

/** Whether a session of today is upcoming, in progress (start <= now < end) or finished. */
export function sessionState(
  session: SessionTime,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): SessionState | null {
  if (dayIndex(now, timeZone) !== session.day) return null; // not today
  const minutes = minutesOfDay(now, timeZone);
  if (minutes < parseHHmm(session.start)) return "upcoming";
  if (minutes < parseHHmm(session.end)) return "ongoing";
  return "done";
}
