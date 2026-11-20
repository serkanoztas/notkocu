import { describe, expect, it } from "vitest";
import {
  dayCodeToIndex,
  dayIndex,
  matchesSessionWindow,
  minutesOfDay,
  weekNo,
} from "./time";

const IST = "Europe/Istanbul"; // UTC+3 all year

describe("dayCodeToIndex", () => {
  it("maps codes to 0=Monday..6=Sunday", () => {
    expect(dayCodeToIndex("MON")).toBe(0);
    expect(dayCodeToIndex("sun")).toBe(6);
    expect(() => dayCodeToIndex("XYZ")).toThrow();
  });
});

describe("dayIndex", () => {
  it("returns 6 for Sunday", () => {
    expect(dayIndex(new Date("2026-11-08T12:00:00+03:00"), IST)).toBe(6);
  });
  it("returns 0 for Monday", () => {
    expect(dayIndex(new Date("2026-11-09T12:00:00+03:00"), IST)).toBe(0);
  });
  it("just after local midnight is the new day", () => {
    // Sunday 23:59 vs Monday 00:01 in Istanbul
    expect(dayIndex(new Date("2026-11-08T23:59:00+03:00"), IST)).toBe(6);
    expect(dayIndex(new Date("2026-11-09T00:01:00+03:00"), IST)).toBe(0);
  });
  it("differs from UTC when the day changes in Istanbul first", () => {
    // 21:30 UTC Sunday = 00:30 Monday in Istanbul
    const d = new Date("2026-11-08T21:30:00Z");
    expect(dayIndex(d, "UTC")).toBe(6);
    expect(dayIndex(d, IST)).toBe(0);
  });
  it("UTC Sunday 22:00 is Monday in Istanbul", () => {
    expect(dayIndex(new Date("2026-11-08T22:00:00Z"), IST)).toBe(0);
  });
  it("still Sunday in Istanbul at 20:59 UTC", () => {
    expect(dayIndex(new Date("2026-11-08T20:59:00Z"), IST)).toBe(6);
  });
});

describe("minutesOfDay", () => {
  it("is computed in the given zone, midnight is 0", () => {
    expect(minutesOfDay(new Date("2026-11-08T21:00:00Z"), IST)).toBe(0);
    expect(minutesOfDay(new Date("2026-11-09T06:00:00Z"), IST)).toBe(9 * 60);
  });
});

describe("weekNo", () => {
  const start = new Date("2026-09-14T00:00:00+03:00"); // Monday
  it("is 1 on the start day and through the first week", () => {
    expect(weekNo(start, new Date("2026-09-14T00:00:00+03:00"), IST)).toBe(1);
    expect(weekNo(start, new Date("2026-09-20T23:59:00+03:00"), IST)).toBe(1);
  });
  it("rolls to week 2 at local midnight, not UTC midnight", () => {
    expect(weekNo(start, new Date("2026-09-20T20:59:00Z"), IST)).toBe(1);
    expect(weekNo(start, new Date("2026-09-20T21:00:00Z"), IST)).toBe(2);
  });
  it("gives week 8 on 9 Nov 2026 for a 21 Sep start (49 days)", () => {
    const sep21 = new Date("2026-09-21T00:00:00+03:00");
    expect(weekNo(sep21, new Date("2026-11-09T10:00:00+03:00"), IST)).toBe(8);
  });
  it("gives week 9 on 9 Nov 2026 for a 14 Sep start (56 days)", () => {
    expect(weekNo(start, new Date("2026-11-09T10:00:00+03:00"), IST)).toBe(9);
  });
  it("is <= 0 before the semester", () => {
    expect(weekNo(start, new Date("2026-09-13T12:00:00+03:00"), IST)).toBe(0);
  });
});

describe("matchesSessionWindow", () => {
  const monday = { day: 0, start: "09:00", end: "10:50" };
  const at = (iso: string) => new Date(iso);
  it("matches from 10 min before start", () => {
    expect(matchesSessionWindow(monday, at("2026-11-09T08:49:00+03:00"), IST)).toBe(false);
    expect(matchesSessionWindow(monday, at("2026-11-09T08:50:00+03:00"), IST)).toBe(true);
  });
  it("matches until 30 min after end", () => {
    expect(matchesSessionWindow(monday, at("2026-11-09T11:20:00+03:00"), IST)).toBe(true);
    expect(matchesSessionWindow(monday, at("2026-11-09T11:21:00+03:00"), IST)).toBe(false);
  });
  it("does not match on another day", () => {
    expect(matchesSessionWindow(monday, at("2026-11-10T09:30:00+03:00"), IST)).toBe(false);
  });
  it("uses the time zone, not the server clock", () => {
    // 06:30 UTC = 09:30 Istanbul Monday
    expect(matchesSessionWindow(monday, at("2026-11-09T06:30:00Z"), IST)).toBe(true);
    expect(matchesSessionWindow(monday, at("2026-11-09T06:30:00Z"), "UTC")).toBe(false);
  });
  it("Sunday session just after midnight Monday does not match", () => {
    const sunLate = { day: 6, start: "22:00", end: "23:30" };
    expect(matchesSessionWindow(sunLate, at("2026-11-09T00:10:00+03:00"), IST)).toBe(false);
  });
});

import { localDateKey, sessionDateTime, startOfNextLocalDay, zonedTimeToDate } from "./time";

describe("zoned helpers (Europe/Istanbul, UTC+3)", () => {
  it("zonedTimeToDate and localDateKey agree", () => {
    const d = zonedTimeToDate({ year: 2026, month: 3, day: 2, hour: 9, minute: 30 }, "Europe/Istanbul");
    expect(d.toISOString()).toBe("2026-03-02T06:30:00.000Z");
    expect(localDateKey(new Date("2026-03-02T22:30:00Z"), "Europe/Istanbul")).toBe("2026-03-03");
  });
  it("startOfNextLocalDay is local midnight", () => {
    expect(startOfNextLocalDay(new Date("2026-03-02T22:30:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-03-03T21:00:00.000Z");
    expect(startOfNextLocalDay(new Date("2026-03-02T10:00:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-03-02T21:00:00.000Z");
  });
  it("is DST-safe (America/New_York spring forward)", () => {
    const d = zonedTimeToDate({ year: 2026, month: 3, day: 9, hour: 9 }, "America/New_York");
    expect(d.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });
});

describe("sessionDateTime", () => {
  const sem = { startDate: "2026-02-16T00:00:00+03:00" }; // a Monday
  it("week 1 Monday and week 3 Wednesday", () => {
    expect(sessionDateTime(sem, { day: 0, start: "09:30", end: "11:20" }, 1, "Europe/Istanbul").toISOString()).toBe("2026-02-16T06:30:00.000Z");
    expect(sessionDateTime(sem, { day: 2, start: "13:00", end: "14:50" }, 3, "Europe/Istanbul").toISOString()).toBe("2026-03-04T10:00:00.000Z");
  });
  it("a semester that starts mid-week: days before the start weekday fall later in week 1", () => {
    const wed = { startDate: "2026-02-18T00:00:00+03:00" };
    // Monday of week 1 is the following Monday (Feb 23); it still counts as week 1 by weekNo (Feb 18..24)
    expect(sessionDateTime(wed, { day: 0, start: "09:00", end: "10:00" }, 1, "Europe/Istanbul").toISOString()).toBe("2026-02-23T06:00:00.000Z");
  });
});
