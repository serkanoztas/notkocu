import { dayIndex } from "@notkocu/shared";

// Calendar dates travel as "YYYY-MM-DD"; the UI shows "GG.AA.YYYY".
// Weekday math always goes through @notkocu/shared (dayIndex), evaluated at noon UTC.

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function isValidIso(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = at(iso);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso);
}

/** Keeps digits only and inserts the dots while typing: "21092026" -> "21.09.2026". */
export function maskDisplayDate(input: string): string {
  const d = input.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}.${d.slice(2)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`;
}

/** "21.09.2026" -> "2026-09-21", or null when incomplete/invalid. */
export function displayToIso(display: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(display);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isValidIso(iso) ? iso : null;
}

export function isoToDisplay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function isMonday(iso: string): boolean {
  return dayIndex(at(iso), "UTC") === 0;
}

function addDays(iso: string, days: number): string {
  const d = at(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nearest Monday (back for Tue-Thu, forward for Fri-Sun). */
export function nearestMonday(iso: string): string {
  const day = dayIndex(at(iso), "UTC");
  return addDays(iso, day <= 3 ? -day : 7 - day);
}

export function todayIso(): string {
  const n = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}
