import { dayIndex, DEFAULT_TIME_ZONE } from "@notkocu/shared";

// Turkish date labels. All "today" decisions use the user's time zone (User.timeZone),
// never the device's, so the app and the API agree.

export const MONTHS = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
] as const;

export const DAY_NAMES = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"] as const;
export const DAY_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"] as const;

/** "Pazartesi, 9 Kasım" for `now` in the given time zone. */
export function formatToday(now: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  const month = MONTHS[Number(parts.month) - 1] ?? "";
  return `${DAY_NAMES[dayIndex(now, timeZone)]}, ${Number(parts.day)} ${month}`;
}

/** "9 Kasım" for a calendar day given as a UTC-noon Date (semester dates are stored that way). */
function dayMonth(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Monday-Friday range of semester week `weekNo`, e.g. "9 Kasım – 13 Kasım". */
export function weekRangeLabel(semesterStart: string, weekNo: number): string {
  const monday = new Date(semesterStart);
  monday.setUTCDate(monday.getUTCDate() + (weekNo - 1) * 7);
  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 4);
  return `${dayMonth(monday)} – ${dayMonth(friday)}`;
}

/** "09:34" for an ISO timestamp in the user's time zone. */
export function formatClock(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("tr-TR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(iso),
  );
}

/** "9 Kasım, 09:34" for an ISO timestamp in the user's time zone. */
export function formatStamp(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" }).formatToParts(
    new Date(iso),
  )) {
    parts[p.type] = p.value;
  }
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}, ${formatClock(iso, timeZone)}`;
}

/** "31:05" or "1:42:10" (player and recorder clocks). */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? h + ":" + String(mm).padStart(2, "0") + ":" + ss : mm + ":" + ss;
}

/** "1 sa 42 dk" / "37 dk" / "45 sn" (lists). */
export function formatDurationWords(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return s + " sn";
  const h = Math.floor(s / 3600);
  const mm = Math.round((s % 3600) / 60);
  return h > 0 ? (mm > 0 ? h + " sa " + mm + " dk" : h + " sa") : mm + " dk";
}
