// ───────────────────────────────────────────────────────────────────────────
// summary.ts — สรุป/รวมยอดของไดอารี่อาหาร (PURE — รับแถวที่โหลดมาแล้ว ไม่แตะ DB)
// ───────────────────────────────────────────────────────────────────────────

import { macroSplit, sumMacros, type MacroSplit, type Macros } from "./macros";
import { SLOT_ORDER, type MealSlot } from "./parse";
import type { MealEntryRow } from "./store";

export interface SlotSummary {
  slot: MealSlot;
  macros: Macros;
  split: MacroSplit;
  count: number;
}

export interface DaySummary {
  total: Macros;
  split: MacroSplit;
  bySlot: SlotSummary[]; // เฉพาะมื้อที่มีข้อมูล เรียงตาม SLOT_ORDER
  count: number;
  /** ชื่ออาหารที่ยังจับคู่ไม่ได้ (ไม่ซ้ำ) — ต้องโชว์เตือน ไม่งั้นยอดรวมจะต่ำกว่าความจริงแบบเงียบ ๆ */
  unresolvedNames: string[];
}

/** แถว DB → Macros (Postgres numeric อาจส่งมาเป็น string จึง Number() ทุกตัว) */
export function rowMacros(row: MealEntryRow): Macros {
  return {
    kcal: Number(row.kcal),
    carbG: Number(row.carb_g),
    proteinG: Number(row.protein_g),
    fatG: Number(row.fat_g),
  };
}

/** รวมยอดทั้งวัน + แยกตามมื้อ */
export function aggregateDay(rows: MealEntryRow[]): DaySummary {
  const total = sumMacros(rows.map(rowMacros));

  const bySlot: SlotSummary[] = [];
  for (const slot of SLOT_ORDER) {
    const inSlot = rows.filter((r) => r.meal_slot === slot);
    if (inSlot.length === 0) continue;
    const macros = sumMacros(inSlot.map(rowMacros));
    bySlot.push({ slot, macros, split: macroSplit(macros), count: inSlot.length });
  }

  const unresolvedNames: string[] = [];
  for (const r of rows) {
    if (r.resolved) continue;
    if (!unresolvedNames.includes(r.food_name)) unresolvedNames.push(r.food_name);
  }

  return { total, split: macroSplit(total), bySlot, count: rows.length, unresolvedNames };
}

// ── การแสดงผลวันที่ (Asia/Bangkok, ปี พ.ศ.) ────────────────────────────────────
const THAI_MONTHS_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];
const THAI_DOW_ABBR = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

/**
 * "2026-08-03" → "จ. 3 ส.ค. 69" (วันในสัปดาห์ + วันที่ + เดือนย่อ + ปี พ.ศ. 2 หลัก).
 * คำนวณผ่าน Date.UTC ล้วน ๆ จึงไม่ขึ้นกับ timezone ของเซิร์ฟเวอร์ (ค่าที่รับมาเป็นวันไทยอยู่แล้ว).
 */
export function formatThaiDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const buddhistShort = String((y + 543) % 100).padStart(2, "0");
  return `${THAI_DOW_ABBR[dow]} ${d} ${THAI_MONTHS_ABBR[mo - 1]} ${buddhistShort}`;
}
