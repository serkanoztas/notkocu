// Single home for all day / time / week conversions.
// Never compute these elsewhere; never use the server's local clock.
// Day index: 0 = Monday ... 6 = Sunday.

export const DEFAULT_TIME_ZONE = "Europe/Istanbul";

export const DAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type DayCode = (typeof DAY_CODES)[number];

/** Minutes before a session start / after its end during which a new note is auto-assigned. */
export const SESSION_WINDOW_BEFORE_MIN = 10;
export const SESSION_WINDOW_AFTER_MIN = 30;

/** "MON" -> 0 ... "SUN" -> 6. Throws on unknown code. */
export function dayCodeToIndex(code: string): number {
  const i = DAY_CODES.indexOf(code.trim().toUpperCase() as DayCode);
  if (i === -1) throw new Error(`Unknown day code: ${code}`);
  return i;
}

export function dayIndexToCode(index: number): DayCode {
  const code = DAY_CODES[index];
  if (!code) throw new Error(`Invalid day index: ${index}`);
  return code;
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of getFormatter(timeZone).formatToParts(date)) out[p.type] = p.value;
  const weekday = WEEKDAY_TO_INDEX[out.weekday ?? ""];
  if (weekday === undefined) throw new Error(`Cannot resolve weekday in ${timeZone}`);
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday,
  };
}

/** Day of week in the given time zone, 0 = Monday ... 6 = Sunday. */
export function dayIndex(date: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  return localParts(date, timeZone).weekday;
}

/** Minutes since local midnight in the given time zone. */
export function minutesOfDay(date: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const p = localParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** "09:30" -> 570 */
export function parseHHmm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time: ${value}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time: ${value}`);
  return h * 60 + min;
}

function calendarDayNumber(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000);
}

/**
 * Week number of `now` relative to the semester start, by calendar days in the time zone:
 * floor((today - startDate) / 7) + 1. Returns <= 0 before the semester starts.
 */
export function weekNo(
  startDate: Date,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const diffDays = calendarDayNumber(now, timeZone) - calendarDayNumber(startDate, timeZone);
  return Math.floor(diffDays / 7) + 1;
}

export interface SessionTime {
  day: number;
  start: string;
  end: string;
}

/**
 * True when `now` is between (start - 10 min) and (end + 30 min) of the session on its day.
 * Windows never cross midnight; they are clamped to the session's calendar day.
 */
export function matchesSessionWindow(
  session: SessionTime,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): boolean {
  const p = localParts(now, timeZone);
  if (p.weekday !== session.day) return false;
  const minutes = p.hour * 60 + p.minute;
  const from = parseHHmm(session.start) - SESSION_WINDOW_BEFORE_MIN;
  const to = parseHHmm(session.end) + SESSION_WINDOW_AFTER_MIN;
  return minutes >= from && minutes <= to;
}
