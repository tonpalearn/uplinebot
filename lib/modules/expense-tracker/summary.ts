// ───────────────────────────────────────────────────────────────────────────
// summary.ts — รวมยอด (aggregate) + คำนวณช่วงเวลา (periodRange). PURE + DETERMINISTIC.
// aggregate: สรุป income/expense/net + แยกหมวด "เฉพาะรายจ่าย" เรียงมาก→น้อย พร้อม %.
// periodRange: ช่วงวัน/สัปดาห์/เดือน เป็นสตริง YYYY-MM-DD (Asia/Bangkok, inclusive) + ป้ายไทย.
// สัปดาห์ = จันทร์..อาทิตย์ ที่ครอบวันนี้. ไม่พึ่ง timezone ของ server (เลื่อน +7 ชม.).
// ───────────────────────────────────────────────────────────────────────────

import type { LedgerKind } from "./categories";

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface LedgerSummary {
  income: number;
  expense: number;
  net: number; // income − expense
  count: number;
  byCat: { category: string; amount: number; pct: number }[]; // รายจ่ายเท่านั้น, เรียงมาก→น้อย
}

/** รวมยอดจากรายการ (kind/amount/category) — amount เป็นค่าบวกเสมอ. */
export function aggregate(
  entries: { kind: LedgerKind; amount: number; category: string }[]
): LedgerSummary {
  let income = 0;
  let expense = 0;
  const catMap = new Map<string, number>();

  for (const e of entries) {
    if (e.kind === "income") {
      income += e.amount;
    } else {
      expense += e.amount;
      catMap.set(e.category, (catMap.get(e.category) ?? 0) + e.amount);
    }
  }

  const byCat = [...catMap.entries()]
    .map(([category, amount]) => ({
      category,
      amount,
      pct: expense > 0 ? (amount / expense) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return { income, expense, net: income - expense, count: entries.length, byCat };
}

// ── Asia/Bangkok date helpers ──────────────────────────────────────────────────
interface BkkYmd {
  y: number;
  m: number; // 1-12
  d: number;
}

function bkkToday(now: Date): BkkYmd {
  const s = new Date(now.getTime() + BKK_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** วันในสัปดาห์ (0=อา..6=ส) ของ wall-clock Bangkok date */
function bkkDow(ymd: BkkYmd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

function addDays(ymd: BkkYmd, days: number): BkkYmd {
  const base = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

function ymdKey(ymd: BkkYmd): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}

const THAI_MONTHS_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

/**
 * ช่วงเวลา (Asia/Bangkok) แบบ inclusive: { from, to } เป็น YYYY-MM-DD + ป้ายไทย.
 *   - day   → วันนี้ (from=to=วันนี้), label เช่น "วันนี้ 3 ก.ค."
 *   - week  → จันทร์..อาทิตย์ ที่ครอบวันนี้, label "สัปดาห์นี้"
 *   - month → วันที่ 1..สิ้นเดือน ของเดือนนี้, label เช่น "เดือน ก.ค."
 */
export function periodRange(
  period: "day" | "week" | "month",
  now: Date
): { from: string; to: string; label: string } {
  const today = bkkToday(now);

  if (period === "day") {
    const key = ymdKey(today);
    return {
      from: key,
      to: key,
      label: `วันนี้ ${today.d} ${THAI_MONTHS_ABBR[today.m - 1]}`,
    };
  }

  if (period === "week") {
    // จันทร์เป็นวันแรก: getUTCDay 0=อา..6=ส → offset ถึงจันทร์ = (dow+6)%7
    const dow = bkkDow(today);
    const toMonday = (dow + 6) % 7;
    const monday = addDays(today, -toMonday);
    const sunday = addDays(monday, 6);
    return { from: ymdKey(monday), to: ymdKey(sunday), label: "สัปดาห์นี้" };
  }

  // month
  const first: BkkYmd = { y: today.y, m: today.m, d: 1 };
  const lastDay = new Date(Date.UTC(today.y, today.m, 0)).getUTCDate();
  const last: BkkYmd = { y: today.y, m: today.m, d: lastDay };
  return {
    from: ymdKey(first),
    to: ymdKey(last),
    label: `เดือน ${THAI_MONTHS_ABBR[today.m - 1]}`,
  };
}
