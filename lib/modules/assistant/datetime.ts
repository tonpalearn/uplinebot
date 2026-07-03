/**
 * Thai natural-language date/time parser for the Todo Manager.
 *
 * parseThaiDateTime(text, now) → { dueAt, cleanedText }
 *   - dueAt: the absolute instant (UTC Date) the phrase refers to, interpreted in
 *     Asia/Bangkok wall-clock time, or null if no date/time was recognized.
 *   - cleanedText: the input with the recognized date/time tokens stripped out
 *     (so the remainder is the task text). If nothing is recognized, cleanedText
 *     is the original text (trimmed) and dueAt is null.
 *
 * PURE + DETERMINISTIC: no DB, no `new Date()` internally — everything is derived
 * from the `now` argument. Callers pass `new Date()` in production; tests pass a fixed
 * instant. Asia/Bangkok is a fixed UTC+7 offset (no DST), so we convert by shifting
 * ±7h rather than pulling in a timezone library:
 *   - to read "today" in Bangkok from `now`: shift now +7h, read its UTC Y/M/D.
 *   - to build an absolute instant for a Bangkok wall-clock Y/M/D H:M: Date.UTC(y,m,d,H-7,M).
 *
 * Supported (best-effort subset, well tested):
 *   Dates: วันนี้ · พรุ่งนี้ · มะรืน/มะรืนนี้ · weekday จันทร์..อาทิตย์ (next occurrence,
 *          today counts only if a later time-of-day is also given) · DD/MM · DD/MM/YYYY
 *          (Buddhist 25xx or Gregorian year both accepted).
 *   Times: HH:MM · HH.MM · "HH นาฬิกา" · "HH โมง" · "บ่าย N (โมง)" · "N ทุ่ม" ·
 *          เที่ยง(=12:00) · เที่ยงคืน(=00:00) · เช้า(=09:00) · บ่าย(=13:00) · เย็น(=17:00).
 * If a date is given without a time, the time defaults to 09:00 Bangkok.
 */

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface ParsedThaiDateTime {
  dueAt: Date | null;
  cleanedText: string;
}

interface BkkYmd {
  y: number;
  m: number; // 1-12
  d: number;
}

/** Bangkok wall-clock Y/M/D for the given absolute instant. */
function bkkToday(now: Date): BkkYmd {
  const shifted = new Date(now.getTime() + BKK_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

/** Day-of-week (0=Sun..6=Sat) of a Bangkok wall-clock date. */
function bkkDow(ymd: BkkYmd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

/** Build the absolute instant for a Bangkok wall-clock Y/M/D H:M. Handles month/day overflow. */
function bkkInstant(ymd: BkkYmd, hour: number, minute: number): Date {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, hour - 7, minute));
}

/** Add whole days to a Bangkok wall-clock date, normalizing via UTC math. */
function addDays(ymd: BkkYmd, days: number): BkkYmd {
  const base = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

interface TimeResult {
  hour: number;
  minute: number;
  matched: string[]; // raw substrings to strip from the text
}

const WEEKDAYS: Array<{ re: RegExp; dow: number; raw: string }> = [
  { re: /วันอาทิตย์|อาทิตย์/, dow: 0, raw: "อาทิตย์" },
  { re: /วันจันทร์|จันทร์/, dow: 1, raw: "จันทร์" },
  { re: /วันอังคาร|อังคาร/, dow: 2, raw: "อังคาร" },
  { re: /วันพุธ|พุธ/, dow: 3, raw: "พุธ" },
  { re: /วันพฤหัสบดี|วันพฤหัส|พฤหัสบดี|พฤหัส/, dow: 4, raw: "พฤหัส" },
  { re: /วันศุกร์|ศุกร์/, dow: 5, raw: "ศุกร์" },
  { re: /วันเสาร์|เสาร์/, dow: 6, raw: "เสาร์" },
];

/**
 * Parse a time-of-day out of the text. Returns the matched hour/minute (24h) plus the
 * raw substrings consumed, or null if no time was found. Tries the most specific /
 * least-ambiguous patterns first.
 */
function parseTime(text: string): TimeResult | null {
  // "บ่าย N โมง" / "บ่าย N" → PM (N in 1..6 → 13..18). Check before bare digits.
  const baaiN = text.match(/บ่าย\s*(\d{1,2})(?:\s*โมง)?/);
  if (baaiN) {
    let h = parseInt(baaiN[1], 10);
    if (h >= 1 && h <= 11) h += 12; // บ่าย 2 = 14:00
    if (h >= 0 && h <= 23) {
      return { hour: h, minute: 0, matched: [baaiN[0]] };
    }
  }

  // "N ทุ่ม" → 18 + N (1 ทุ่ม = 19:00 .. 5 ทุ่ม = 23:00). ทุ่ม alone (no N) = 19:00.
  const thum = text.match(/(\d{1,2})\s*ทุ่ม/);
  if (thum) {
    const n = parseInt(thum[1], 10);
    if (n >= 1 && n <= 6) {
      return { hour: 18 + n, minute: 0, matched: [thum[0]] };
    }
  }
  const thumBare = text.match(/ทุ่ม/);

  // "ตี N" → early morning (ตี 1 = 01:00 .. ตี 5 = 05:00).
  const tee = text.match(/ตี\s*(\d{1,2})/);
  if (tee) {
    const n = parseInt(tee[1], 10);
    if (n >= 1 && n <= 6) {
      return { hour: n, minute: 0, matched: [tee[0]] };
    }
  }

  // HH:MM or HH.MM (dot form only when it looks like a clock: 1-2 digit hour, 2 digit min).
  const hm = text.match(/(\d{1,2})[:.](\d{2})/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const min = parseInt(hm[2], 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return { hour: h, minute: min, matched: [hm[0]] };
    }
  }

  // "HH นาฬิกา" or "HH โมง" (24h-ish; โมง is colloquial but we take the number as given).
  const hourWord = text.match(/(\d{1,2})\s*(?:นาฬิกา|โมง)/);
  if (hourWord) {
    const h = parseInt(hourWord[1], 10);
    if (h >= 0 && h <= 23) {
      return { hour: h, minute: 0, matched: [hourWord[0]] };
    }
  }

  // Named times.
  if (/เที่ยงคืน/.test(text)) return { hour: 0, minute: 0, matched: ["เที่ยงคืน"] };
  if (/เที่ยงวัน|เที่ยง/.test(text)) return { hour: 12, minute: 0, matched: ["เที่ยง"] };
  if (thumBare) return { hour: 19, minute: 0, matched: ["ทุ่ม"] };
  if (/ตอนเช้า|เช้า/.test(text)) return { hour: 9, minute: 0, matched: ["เช้า"] };
  if (/ตอนเย็น|เย็น/.test(text)) return { hour: 17, minute: 0, matched: ["เย็น"] };
  // บ่าย alone (no number) = 13:00. Checked last so "บ่าย 2" is handled above.
  if (/ตอนบ่าย|บ่าย/.test(text)) return { hour: 13, minute: 0, matched: ["บ่าย"] };

  return null;
}

interface DateResult {
  ymd: BkkYmd;
  matched: string[];
  /** true when the phrase pinned a specific day (so weekday "today" logic can differ). */
  explicit: boolean;
}

/** Normalize a possibly-Buddhist 4-digit year to Gregorian. 2400..2600 → -543. */
function normalizeYear(y: number): number {
  if (y >= 2400 && y <= 2600) return y - 543;
  if (y < 100) return 2000 + y; // 2-digit year → 20xx
  return y;
}

/**
 * Parse an explicit/relative DATE out of the text. Returns the Bangkok Y/M/D plus the raw
 * substrings consumed, or null. `hasTime` lets weekday "วันนี้ counts as next occurrence
 * only if a later time is also present" behavior be decided by the caller instead — here we
 * simply resolve weekday to the soonest strictly-future day (today only if hasTime allows).
 */
function parseDate(text: string, today: BkkYmd, hasTime: boolean): DateResult | null {
  // DD/MM/YYYY or DD/MM (also accepts - as separator).
  const dmy = text.match(/(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/);
  if (dmy) {
    const d = parseInt(dmy[1], 10);
    const m = parseInt(dmy[2], 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      const y = dmy[3] ? normalizeYear(parseInt(dmy[3], 10)) : today.y;
      let ymd: BkkYmd = { y, m, d };
      // No year given and the date already passed this year → assume next year.
      if (!dmy[3]) {
        const candidate = new Date(Date.UTC(y, m - 1, d));
        const todayUtc = new Date(Date.UTC(today.y, today.m - 1, today.d));
        if (candidate.getTime() < todayUtc.getTime()) {
          ymd = { y: y + 1, m, d };
        }
      }
      return { ymd, matched: [dmy[0]], explicit: true };
    }
  }

  // Relative day words.
  if (/มะรืนนี้|มะรืน/.test(text)) {
    return { ymd: addDays(today, 2), matched: ["มะรืน"], explicit: true };
  }
  if (/พรุ่งนี้/.test(text)) {
    return { ymd: addDays(today, 1), matched: ["พรุ่งนี้"], explicit: true };
  }
  if (/วันนี้/.test(text)) {
    return { ymd: today, matched: ["วันนี้"], explicit: true };
  }

  // Weekday name → next occurrence. If it's the same weekday as today, jump 7 days ahead
  // UNLESS a time is also present (then "today" is a valid same-day target).
  for (const wd of WEEKDAYS) {
    if (wd.re.test(text)) {
      const todayDow = bkkDow(today);
      let delta = (wd.dow - todayDow + 7) % 7;
      if (delta === 0 && !hasTime) delta = 7;
      const rawMatch = text.match(wd.re);
      return {
        ymd: addDays(today, delta),
        matched: rawMatch ? [rawMatch[0]] : [wd.raw],
        explicit: true,
      };
    }
  }

  return null;
}

/** Remove each matched substring once, then collapse leftover whitespace and connective words. */
function stripTokens(text: string, tokens: string[]): string {
  let out = text;
  for (const tok of tokens) {
    const idx = out.indexOf(tok);
    if (idx >= 0) {
      out = out.slice(0, idx) + " " + out.slice(idx + tok.length);
    }
  }
  // Drop dangling Thai time/date connectors left behind ("ตอน", "เวลา", "วัน") and tidy spaces.
  out = out
    .replace(/\bตอน\b/g, " ")
    .replace(/\bเวลา\b/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Remove a trailing lone "วัน" that can be orphaned by weekday stripping.
  out = out.replace(/\s*วัน\s*$/g, "").trim();
  return out;
}

/**
 * Absolute instant for TODAY (Asia/Bangkok) at the given time (default 09:00) — used as the
 * default due date for a task added with NO explicit date/time ("พิมพ์เฉย ๆ = วันนี้").
 */
export function bkkDueDefault(now: Date, hour = 9, minute = 0): Date {
  return bkkInstant(bkkToday(now), hour, minute);
}

export function parseThaiDateTime(text: string, now: Date): ParsedThaiDateTime {
  const original = (text ?? "").trim();
  if (!original) return { dueAt: null, cleanedText: original };

  const today = bkkToday(now);

  const time = parseTime(original);
  const date = parseDate(original, today, time !== null);

  if (!date && !time) {
    return { dueAt: null, cleanedText: original };
  }

  const targetYmd = date ? date.ymd : today;
  const hour = time ? time.hour : 9; // date-only default = 09:00 Bangkok
  const minute = time ? time.minute : 0;

  const dueAt = bkkInstant(targetYmd, hour, minute);

  const matched = [...(date?.matched ?? []), ...(time?.matched ?? [])];
  const cleanedText = stripTokens(original, matched) || original;

  return { dueAt, cleanedText };
}

/**
 * Format an absolute instant as a short Thai date/time relative to `now`, in Asia/Bangkok.
 * Examples: "วันนี้ 14:00", "พรุ่งนี้ 09:00", "25 ธ.ค. 09:00".
 * Time is always shown (tasks with due_at always have a time — date-only defaults to 09:00).
 */
const THAI_MONTHS_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

export function formatThaiDueAt(due: Date, now: Date): string {
  const dueBkk = new Date(due.getTime() + BKK_OFFSET_MS);
  const y = dueBkk.getUTCFullYear();
  const m = dueBkk.getUTCMonth(); // 0-11
  const d = dueBkk.getUTCDate();
  const hh = String(dueBkk.getUTCHours()).padStart(2, "0");
  const mm = String(dueBkk.getUTCMinutes()).padStart(2, "0");
  const timeStr = `${hh}:${mm}`;

  const today = bkkToday(now);
  const dueYmd: BkkYmd = { y, m: m + 1, d };

  const dueUtc = Date.UTC(dueYmd.y, dueYmd.m - 1, dueYmd.d);
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
  const dayDiff = Math.round((dueUtc - todayUtc) / (24 * 60 * 60 * 1000));

  if (dayDiff === 0) return `วันนี้ ${timeStr}`;
  if (dayDiff === 1) return `พรุ่งนี้ ${timeStr}`;
  if (dayDiff === 2) return `มะรืน ${timeStr}`;

  return `${d} ${THAI_MONTHS_ABBR[m]} ${timeStr}`;
}
