"use client";

// Shared helpers for the customer planner page: design tokens (matching public/guide.html)
// + Asia/Bangkok (fixed UTC+7, no DST) date math. Kept in one client module so page.tsx and
// its sub-components share the exact same palette + timezone conversions.
//
// Timezone: the bot stores due_at as an absolute UTC instant that represents a Bangkok
// wall-clock time (see lib/modules/assistant/datetime.ts). The planner reads/writes in the
// customer's Bangkok wall clock, so we convert by shifting ±7h rather than trusting the
// browser's local zone (a customer abroad must still see Bangkok time).

export const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

// Theme tokens — resolve against globals.css so the planner flips light/dark with the app.
export const T = {
  bg: "var(--bg)",
  panel: "var(--surface)",
  panel2: "var(--surface-2)",
  border: "var(--border)",
  border2: "var(--border-strong)",
  text: "var(--fg)",
  muted: "var(--muted)",
  dim: "var(--muted-2)",
  blue: "var(--primary)",
  green: "var(--success)",
  purple: "var(--accent)",
  gold: "var(--gold)",
  danger: "var(--danger)",
  onAccent: "var(--primary-fg)", // text/icon color on any accent-colored surface
} as const;

export const FONT = "var(--font-sans)";
export const MONO = "'JetBrains Mono', ui-monospace, monospace";

export interface Todo {
  id: string;
  content: string;
  done: boolean;
  due_at: string | null;
  sort_order: number | null;
  // Per-task reminder-lead OVERRIDE in minutes before due_at (null = use the target default).
  remind_before_minutes: number | null;
  created_at: string;
}

// Server clamps lead to 24h (lib/reminders.MAX_LEAD_MINUTES). Kept here so the UI presets
// never offer a value the API would silently trim.
export const MAX_LEAD_MINUTES = 1440;

/** Preset lead options for the TARGET default control (minutes before due; 0 = at due time). */
export const LEAD_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "ไม่เตือนล่วงหน้า", value: 0 },
  { label: "5 นาที", value: 5 },
  { label: "10", value: 10 },
  { label: "15", value: 15 },
  { label: "30", value: 30 },
  { label: "1 ชม.", value: 60 },
  { label: "1 วัน", value: 1440 },
];

/**
 * Preset lead options for a PER-TASK override. `value === null` means "clear the override
 * → fall back to the target default"; a number is the explicit per-task lead in minutes.
 */
export const TASK_LEAD_PRESETS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: "ตามค่าเริ่มต้น", value: null },
  { label: "ตรงเวลา", value: 0 },
  { label: "5", value: 5 },
  { label: "10", value: 10 },
  { label: "15", value: 15 },
  { label: "30", value: 30 },
  { label: "1 ชม.", value: 60 },
  { label: "1 วัน", value: 1440 },
];

export interface BkkYmd {
  y: number;
  m: number; // 1-12
  d: number;
}

export const THAI_MONTHS_FULL = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

export const THAI_MONTHS_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

// Sun-first weekday labels (matches JS getUTCDay 0..6 = Sun..Sat).
export const THAI_WEEKDAYS_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** Bangkok wall-clock Y/M/D for an absolute instant. */
export function bkkYmdOf(instant: Date): BkkYmd {
  const s = new Date(instant.getTime() + BKK_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** Bangkok wall-clock hour/minute for an absolute instant. */
export function bkkHmOf(instant: Date): { hh: number; mm: number } {
  const s = new Date(instant.getTime() + BKK_OFFSET_MS);
  return { hh: s.getUTCHours(), mm: s.getUTCMinutes() };
}

/** Day-of-week (0=Sun..6=Sat) of a Bangkok wall-clock date. */
export function bkkDow(ymd: BkkYmd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

/** Days in a given Bangkok month (m: 1-12). */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** A stable YYYY-MM-DD key for a Bangkok wall-clock date (used to bucket tasks by day). */
export function ymdKey(ymd: BkkYmd): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}

/** The day-bucket key for a todo's due_at (Bangkok), or null if undated. */
export function dueDayKey(due_at: string | null): string | null {
  if (!due_at) return null;
  const t = Date.parse(due_at);
  if (Number.isNaN(t)) return null;
  return ymdKey(bkkYmdOf(new Date(t)));
}

/**
 * Build an absolute UTC instant from a Bangkok wall-clock date + time.
 * Inverse of bkkYmdOf/bkkHmOf: Date.UTC(y, m-1, d, hour-7, minute).
 */
export function bkkInstant(ymd: BkkYmd, hour: number, minute: number): Date {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, hour - 7, minute));
}

/**
 * Convert a due_at ISO instant to the value a <input type="datetime-local"> expects,
 * expressed in Bangkok wall-clock time: "YYYY-MM-DDTHH:MM". Empty string if undated.
 */
export function toDatetimeLocalValue(due_at: string | null): string {
  if (!due_at) return "";
  const t = Date.parse(due_at);
  if (Number.isNaN(t)) return "";
  const ymd = bkkYmdOf(new Date(t));
  const { hh, mm } = bkkHmOf(new Date(t));
  return (
    `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}` +
    `T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
  );
}

/**
 * Parse a <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM"), interpreted as a
 * Bangkok wall-clock time, into an absolute UTC ISO string. Empty/invalid → null.
 */
export function datetimeLocalToIso(value: string): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const instant = bkkInstant(
    { y: Number(y), m: Number(mo), d: Number(d) },
    Number(hh),
    Number(mm)
  );
  return instant.toISOString();
}

/**
 * Build the datetime-local value for a given day at a default time (used when the customer
 * adds a task straight onto a calendar day: default 09:00 Bangkok, matching the bot).
 */
export function dayAtDefaultTime(ymd: BkkYmd, hour = 9, minute = 0): string {
  return (
    `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  );
}

/** Short Thai time "HH:MM" (Bangkok) for a due_at. */
export function fmtTime(due_at: string | null): string {
  if (!due_at) return "";
  const t = Date.parse(due_at);
  if (Number.isNaN(t)) return "";
  const { hh, mm } = bkkHmOf(new Date(t));
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Human Thai label for a due_at relative to `now` (Bangkok): "วันนี้ 14:00",
 * "พรุ่งนี้ 09:00", "มะรืน 08:00", else "25 ธ.ค. 09:00". Mirrors formatThaiDueAt in datetime.ts.
 */
export function fmtDueRelative(due_at: string | null, now: Date): string {
  if (!due_at) return "";
  const t = Date.parse(due_at);
  if (Number.isNaN(t)) return "";
  const due = new Date(t);
  const dueYmd = bkkYmdOf(due);
  const today = bkkYmdOf(now);
  const time = fmtTime(due_at);

  const dueUtc = Date.UTC(dueYmd.y, dueYmd.m - 1, dueYmd.d);
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
  const dayDiff = Math.round((dueUtc - todayUtc) / (24 * 60 * 60 * 1000));

  if (dayDiff === 0) return `วันนี้ ${time}`;
  if (dayDiff === 1) return `พรุ่งนี้ ${time}`;
  if (dayDiff === 2) return `มะรืน ${time}`;
  if (dayDiff === -1) return `เมื่อวาน ${time}`;
  return `${dueYmd.d} ${THAI_MONTHS_ABBR[dueYmd.m - 1]} ${time}`;
}

/** True if the due_at is in the past relative to `now` (for overdue styling). */
export function isOverdue(due_at: string | null, now: Date): boolean {
  if (!due_at) return false;
  const t = Date.parse(due_at);
  if (Number.isNaN(t)) return false;
  return t < now.getTime();
}
