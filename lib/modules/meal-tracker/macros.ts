// ───────────────────────────────────────────────────────────────────────────
// macros.ts — คณิตศาสตร์ของสารอาหาร (PURE, ไม่แตะ DB) — หัวใจความถูกต้องของโมดูลนี้
//
// กฎเหล็ก 2 ข้อ:
//  1) พลังงานที่ใช้คิด "สัดส่วน %" มาจากมาโครเสมอ ด้วยสูตร Atwater — คาร์บ 4 · โปรตีน 4 · ไขมัน 9
//     kcal/กรัม จึงรับประกันว่า %C + %P + %F = 100 เสมอ และไม่มีวันขัดกับตัวเลข "กรัม" บนการ์ด
//  2) การแปลงหน่วย ⇄ กรัม ทำที่เดียวที่นี่ (scaleFactor) โมดูลอื่นห้ามคำนวณเอง
// ───────────────────────────────────────────────────────────────────────────

import type { ParsedFoodLine, FoodBasis } from "./parse";

/** พลังงานต่อกรัมตามสูตร Atwater */
export const KCAL_PER_G = { carb: 4, protein: 4, fat: 9 } as const;

/** แถวอาหารจากฐาน (ตัดให้เหลือเฉพาะฟิลด์ที่การคำนวณต้องใช้) */
export interface FoodRef {
  id: string;
  name: string;
  basis: FoodBasis;
  unitLabel: string | null;
  unitGrams: number | null;
  kcal: number;
  carbG: number;
  proteinG: number;
  fatG: number;
  source: string;
}

/** ชุดมาโครหนึ่งชุด (กรัม) + พลังงาน */
export interface Macros {
  kcal: number;
  carbG: number;
  proteinG: number;
  fatG: number;
}

/** สัดส่วนพลังงานจากแต่ละสารอาหาร (%) — รวมกันได้ 100 เสมอ (เว้นแต่พลังงาน = 0) */
export interface MacroSplit {
  carbPct: number;
  proteinPct: number;
  fatPct: number;
  /** พลังงานที่คำนวณจากมาโคร (Atwater) — ใช้เป็นตัวหารของ % */
  atwaterKcal: number;
}

/** ถ้าอาหารไม่มี unit_grams ให้เดา 1 หน่วย = 100 กรัม (ค่ากลางที่ปลอดภัยที่สุดสำหรับ per_100g) */
const DEFAULT_UNIT_GRAMS = 100;

/**
 * ตัวคูณที่ต้องเอาไปคูณกับค่ามาโคร "ต่อฐาน" ของอาหารนั้น เพื่อให้ได้ปริมาณที่กินจริง.
 *
 *   basis per_100g + พิมพ์กรัมมา   → grams / 100
 *   basis per_100g + พิมพ์หน่วยมา  → (qty × unitGrams) / 100      (ทัพพี/ฟอง → กรัม ก่อน)
 *   basis per_serving + พิมพ์หน่วย → qty                          (2 จาน = ×2)
 *   basis per_serving + พิมพ์กรัม  → grams / unitGrams            (350g ของจานละ 350g = ×1)
 *
 * คืน `grams` ด้วยเมื่อคำนวณได้ (ไว้โชว์ "≈ 120 g" บนการ์ด) — null เมื่อไม่รู้น้ำหนักต่อหน่วย
 * ของเมนู per_serving (เช่น "ที่" ที่ไม่ได้ระบุน้ำหนัก) ซึ่งไม่กระทบความถูกต้องของมาโคร.
 */
export function scaleFactor(line: ParsedFoodLine, food: FoodRef): { factor: number; grams: number | null } {
  const unitGrams = food.unitGrams && food.unitGrams > 0 ? food.unitGrams : null;

  if (food.basis === "per_100g") {
    const grams = line.unit === "g" ? line.qty : line.qty * (unitGrams ?? DEFAULT_UNIT_GRAMS);
    return { factor: grams / 100, grams };
  }

  // per_serving
  if (line.unit === "g") {
    const per = unitGrams ?? DEFAULT_UNIT_GRAMS;
    return { factor: line.qty / per, grams: line.qty };
  }
  return { factor: line.qty, grams: unitGrams ? line.qty * unitGrams : null };
}

/** ปัดทศนิยม 1 ตำแหน่งแบบไม่มี -0 */
function r1(n: number): number {
  const v = Math.round(n * 10) / 10;
  return Object.is(v, -0) ? 0 : v;
}

/** คำนวณมาโครของ 1 บรรทัดรายการ เมื่อจับคู่กับอาหารในฐานได้แล้ว */
export function computeLineMacros(
  line: ParsedFoodLine,
  food: FoodRef
): Macros & { grams: number | null; factor: number } {
  const { factor, grams } = scaleFactor(line, food);
  const carbG = r1(food.carbG * factor);
  const proteinG = r1(food.proteinG * factor);
  const fatG = r1(food.fatG * factor);
  return {
    // พลังงานคิดจากมาโครเสมอ (Atwater) เพื่อให้ตรงกับ % บนกราฟโดนัทเป๊ะ ๆ
    kcal: Math.round(carbG * KCAL_PER_G.carb + proteinG * KCAL_PER_G.protein + fatG * KCAL_PER_G.fat),
    carbG,
    proteinG,
    fatG,
    grams: grams === null ? null : r1(grams),
    factor,
  };
}

/** รวมมาโครหลายชุด */
export function sumMacros(list: Macros[]): Macros {
  const total = list.reduce(
    (acc, m) => ({
      kcal: acc.kcal + m.kcal,
      carbG: acc.carbG + m.carbG,
      proteinG: acc.proteinG + m.proteinG,
      fatG: acc.fatG + m.fatG,
    }),
    { kcal: 0, carbG: 0, proteinG: 0, fatG: 0 }
  );
  return {
    kcal: Math.round(total.kcal),
    carbG: r1(total.carbG),
    proteinG: r1(total.proteinG),
    fatG: r1(total.fatG),
  };
}

/**
 * สัดส่วน %พลังงานจากแต่ละสารอาหาร — ปัดเป็นจำนวนเต็มแบบ "largest remainder"
 * เพื่อให้ผลรวมเป็น 100 พอดีเสมอ (ปัดแยกกันจะได้ 99 หรือ 101 ซึ่งดูผิดบนการ์ด).
 */
export function macroSplit(m: Macros): MacroSplit {
  const kc = m.carbG * KCAL_PER_G.carb;
  const kp = m.proteinG * KCAL_PER_G.protein;
  const kf = m.fatG * KCAL_PER_G.fat;
  const total = kc + kp + kf;

  if (total <= 0) return { carbPct: 0, proteinPct: 0, fatPct: 0, atwaterKcal: 0 };

  const exact = [(kc / total) * 100, (kp / total) * 100, (kf / total) * 100];
  const floors = exact.map((v) => Math.floor(v));
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);

  // แจกเศษที่เหลือให้ตัวที่มีทศนิยมมากสุดก่อน
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (remainder <= 0) break;
    floors[o.i] += 1;
    remainder -= 1;
  }

  return {
    carbPct: floors[0],
    proteinPct: floors[1],
    fatPct: floors[2],
    atwaterKcal: Math.round(total),
  };
}
