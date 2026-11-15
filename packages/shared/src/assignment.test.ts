import { describe, expect, it } from "vitest";
import { resolveAutoTarget, semesterWeekNo, sessionState, type AssignableSession } from "./assignment";

const IST = "Europe/Istanbul"; // UTC+3 all year
// Monday 2026-11-02 is week 1; Monday 2026-11-09 is week 2.
const semester = { startDate: "2026-11-02T12:00:00.000Z", weekCount: 14 };

const at = (iso: string) => new Date(`${iso}+03:00`);

const sessions: AssignableSession[] = [
  { _id: "s1", courseId: "c1", day: 0, start: "09:00", end: "10:50" },
  { _id: "s2", courseId: "c2", day: 0, start: "11:00", end: "12:50" },
  { _id: "s3", courseId: "c3", day: 2, start: "13:00", end: "14:50" },
];

describe("resolveAutoTarget", () => {
  it("assigns inside the session", () => {
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T09:30:00"), IST)).toEqual({
      courseId: "c1",
      weekNo: 2,
      sessionId: "s1",
    });
  });

  it("uses the window edges: 10 min before start, 30 min after end", () => {
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T08:50:00"), IST)?.courseId).toBe("c1");
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T08:49:00"), IST)).toBeNull();
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T11:20:00"), IST)?.courseId).toBe("c2");
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T13:21:00"), IST)).toBeNull();
  });

  it("prefers the session in progress when windows overlap", () => {
    // 10:55: s1 ended 5 min ago (in its +30 window), s2 starts in 5 min (in its -10 window): tie -> earlier start.
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T10:55:00"), IST)?.courseId).toBe("c1");
    // 11:00: s2 in progress (distance 0) beats s1 (10 min after end).
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T11:00:00"), IST)?.courseId).toBe("c2");
  });

  it("returns null on a day without sessions", () => {
    expect(resolveAutoTarget(semester, sessions, at("2026-11-10T09:30:00"), IST)).toBeNull();
  });

  it("returns null before the semester starts and after its last week", () => {
    expect(resolveAutoTarget(semester, sessions, at("2026-10-26T09:30:00"), IST)).toBeNull();
    expect(resolveAutoTarget(semester, sessions, at("2027-02-08T09:30:00"), IST)).toBeNull();
  });

  it("uses the given time zone, not the server clock", () => {
    // 09:30 in Istanbul is 06:30 UTC, which is 01:30 in New York on the same Monday.
    expect(resolveAutoTarget(semester, sessions, at("2026-11-09T09:30:00"), "America/New_York")).toBeNull();
  });
});

describe("semesterWeekNo", () => {
  it("is null outside the semester", () => {
    expect(semesterWeekNo(semester, at("2026-11-01T12:00:00"), IST)).toBeNull();
    expect(semesterWeekNo(semester, at("2026-11-09T00:30:00"), IST)).toBe(2);
  });
});

describe("sessionState", () => {
  const s = { day: 0, start: "09:00", end: "10:50" };
  it("tracks upcoming / ongoing / done and ignores other days", () => {
    expect(sessionState(s, at("2026-11-09T08:00:00"), IST)).toBe("upcoming");
    expect(sessionState(s, at("2026-11-09T09:00:00"), IST)).toBe("ongoing");
    expect(sessionState(s, at("2026-11-09T10:50:00"), IST)).toBe("done");
    expect(sessionState(s, at("2026-11-10T09:30:00"), IST)).toBeNull();
  });
});
