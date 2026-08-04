import { KCAL_PER_G, type Macros } from "./macros";

/**
 * เป้าหมายต่อวัน + การคำนวณความคืบหน้า — PURE ไม่แตะ DB (แพตเทิร์นเดียวกับ macros.ts).
 *
 * กติกาความถูกต้อง (ต่อยอดจากกฎเหล็กของ macros.ts):
 *   • เป้าเก็บเป็น "กรัม" เป็นความจริงหลัก — % และ kcal ของแต่ละสารอาหารคำนวณจากกรัมด้วย Atwater
 *     เสมอ จึงไม่มีวันขัดกันเองบนการ์ด
 *   • `kcal` ของเป้าเป็นเลขที่ผู้ใช้ตั้งไว้ตรง ๆ ซึ่งอาจไม่เท่ากับผลรวม Atwater ของกรัมเป๊ะ ๆ
 *     (เพราะปัดเศษกรัม) — เราจึงรายงาน "ส่วนต่าง" ให้เห็น ไม่กลบ ดู `macroKcalTotal`
 */

/** เป้าหมายต่อวัน (กรัม + พลังงานที่ผู้ใช้ตั้งไว้) */
export interface MealGoal {
  kcal: number;
  carbG: number;
  proteinG: number;
  fatG: number;
}

/** สัดส่วนพลังงานเริ่มต้นเมื่อผู้ใช้ตั้งมาแค่ตัวเลขแคลอรี่ — กลาง ๆ ตามคำแนะนำทั่วไป (AMDR) */
export const DEFAULT_SPLIT = { carbPct: 50, proteinPct: 20, fatPct: 30 } as const;

/** ความคืบหน้าของสารอาหารหนึ่งตัว — มีครบทั้งกรัม, kcal และ % ให้หน้าจอหยิบไปใช้ได้เลย */
export interface MacroProgress {
  /** กินไปแล้วกี่กรัม */
  eatenG: number;
  /** เป้ากี่กรัม */
  goalG: number;
  /** เหลือได้อีกกี่กรัม (ติดลบ = เกินเป้า) */
  leftG: number;
  /** กินไปแล้วคิดเป็นกี่ kcal (Atwater) */
  eatenKcal: number;
  /** เป้าคิดเป็นกี่ kcal */
  goalKcal: number;
  /** เหลือได้อีกกี่ kcal (ติดลบ = เกิน) */
  leftKcal: number;
  /** กินไปแล้วกี่ % ของเป้า — ปัดจำนวนเต็ม, ไม่ตัดเพดานที่ 100 (เกินเป้าต้องเห็นว่าเกิน) */
  pct: number;
  /** true = กินเกินเป้าแล้ว */
  over: boolean;
}

export interface GoalProgress {
  goal: MealGoal;
  kcal: MacroProgress;
  carb: MacroProgress;
  protein: MacroProgress;
  fat: MacroProgress;
  /**
   * ผลรวม kcal ของเป้าที่คำนวณจากกรัมด้วย Atwater — ถ้าต่างจาก goal.kcal มาก แปลว่าเป้าที่ตั้ง
   * ไม่สอดคล้องกันเอง (ผู้ใช้ตั้งกรัมเองแบบไม่พอดี) หน้าจอเอาไปเตือนได้
   */
  macroKcalTotal: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** สร้างความคืบหน้าของสารอาหารหนึ่งตัว (kcalPerG = null → นี่คือแถวพลังงานรวม) */
function progress(eatenG: number, goalG: number, kcalPerG: number): MacroProgress {
  const leftG = goalG - eatenG;
  return {
    eatenG: round1(eatenG),
    goalG: round1(goalG),
    leftG: round1(leftG),
    eatenKcal: Math.round(eatenG * kcalPerG),
    goalKcal: Math.round(goalG * kcalPerG),
    leftKcal: Math.round(leftG * kcalPerG),
    pct: goalG > 0 ? Math.round((eatenG / goalG) * 100) : 0,
    over: eatenG > goalG,
  };
}

/** เทียบ "ที่กินไปแล้ววันนี้" กับเป้า → ตัวเลขครบทุกหน่วยที่การ์ด/หน้าเว็บต้องใช้ */
export function computeProgress(goal: MealGoal, eaten: Macros): GoalProgress {
  const kcalLeft = goal.kcal - eaten.kcal;
  return {
    goal,
    // แถวพลังงาน: "กรัม" ไม่มีความหมาย จึงใช้ค่า kcal ทั้งคู่ (kcalPerG = 1)
    kcal: {
      ...progress(eaten.kcal, goal.kcal, 1),
      eatenKcal: Math.round(eaten.kcal),
      goalKcal: Math.round(goal.kcal),
      leftKcal: Math.round(kcalLeft),
    },
    carb: progress(eaten.carbG, goal.carbG, KCAL_PER_G.carb),
    protein: progress(eaten.proteinG, goal.proteinG, KCAL_PER_G.protein),
    fat: progress(eaten.fatG, goal.fatG, KCAL_PER_G.fat),
    macroKcalTotal: Math.round(
      goal.carbG * KCAL_PER_G.carb + goal.proteinG * KCAL_PER_G.protein + goal.fatG * KCAL_PER_G.fat
    ),
  };
}

/**
 * แปลง "แคลอรี่ + สัดส่วน %" → เป้าเป็นกรัม.
 * ถ้า % รวมไม่ได้ 100 จะถูกปรับสัดส่วนให้ครบ 100 โดยรักษาอัตราส่วนเดิม (ผู้ใช้พิมพ์ 40/30/30
 * หรือ 45/25/25 ก็ควรใช้งานได้ ไม่ต้องมานั่งบวกให้พอดี)
 */
export function goalFromPercent(
  kcal: number,
  carbPct: number,
  proteinPct: number,
  fatPct: number
): MealGoal {
  const sum = carbPct + proteinPct + fatPct;
  const norm = sum > 0 ? 100 / sum : 0;
  const c = carbPct * norm;
  const p = proteinPct * norm;
  const f = fatPct * norm;
  return {
    kcal: Math.round(kcal),
    carbG: round1((kcal * c) / 100 / KCAL_PER_G.carb),
    proteinG: round1((kcal * p) / 100 / KCAL_PER_G.protein),
    fatG: round1((kcal * f) / 100 / KCAL_PER_G.fat),
  };
}

/**
 * แปลง "กรัมของแต่ละสารอาหาร" → เป้า (คำนวณ kcal ให้ด้วย Atwater).
 * ใช้เมื่อผู้ใช้ตั้งเป้าเป็นกรัมตรง ๆ เช่นคนที่คุมโปรตีนเป็นหลัก
 */
export function goalFromGrams(carbG: number, proteinG: number, fatG: number): MealGoal {
  return {
    kcal: Math.round(
      carbG * KCAL_PER_G.carb + proteinG * KCAL_PER_G.protein + fatG * KCAL_PER_G.fat
    ),
    carbG: round1(carbG),
    proteinG: round1(proteinG),
    fatG: round1(fatG),
  };
}

/** สัดส่วน % ของเป้า (คำนวณกลับจากกรัม) — ไว้แสดงว่า "เป้านี้คือ C50:P20:F30" */
export function goalSplit(goal: MealGoal): { carbPct: number; proteinPct: number; fatPct: number } {
  const c = goal.carbG * KCAL_PER_G.carb;
  const p = goal.proteinG * KCAL_PER_G.protein;
  const f = goal.fatG * KCAL_PER_G.fat;
  const total = c + p + f;
  if (total <= 0) return { carbPct: 0, proteinPct: 0, fatPct: 0 };

  // ปัดให้รวมได้ 100 พอดีเสมอ: ปัด 2 ตัวแรก แล้วให้ตัวสุดท้ายรับเศษที่เหลือ
  const carbPct = Math.round((c / total) * 100);
  const proteinPct = Math.round((p / total) * 100);
  return { carbPct, proteinPct, fatPct: 100 - carbPct - proteinPct };
}
