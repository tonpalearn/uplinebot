import { describe, it, expect } from "vitest";
import {
  computeProgress,
  goalFromGrams,
  goalFromPercent,
  goalSplit,
  DEFAULT_SPLIT,
} from "../lib/modules/meal-tracker/goal";
import { parseMealIntent } from "../lib/modules/meal-tracker/parse";
import { buildGoalCard, buildGoalSetText, buildNoGoalText } from "../lib/modules/meal-tracker/flex";

/**
 * เป้าหมายต่อวัน + ความคืบหน้า/โควตาคงเหลือ.
 *
 * สัญญาที่ต้องล็อก: ตัวเลขบนการ์ดกับบนเว็บมาจากฟังก์ชันเดียวกัน (computeProgress) และ
 * **kcal ต้องสอดคล้องกับกรัมเสมอ** ด้วย Atwater 4/4/9 — ถ้าสองอย่างนี้หลุดจากกัน ผู้ใช้จะเห็น
 * "เหลือ 200 kcal" แต่ "เหลือคาร์บ 0 g" พร้อมกัน แล้วไม่รู้จะเชื่ออันไหน
 */

const NOW = new Date("2026-08-04T05:00:00Z");

describe("goalFromPercent", () => {
  it("กระจายแคลอรี่ตามสัดส่วนด้วย Atwater", () => {
    // 1800 @ 50/20/30 → คาร์บ 900kcal/4 = 225g · โปรตีน 360/4 = 90g · ไขมัน 540/9 = 60g
    expect(goalFromPercent(1800, 50, 20, 30)).toEqual({
      kcal: 1800, carbG: 225, proteinG: 90, fatG: 60,
    });
  });

  it("% ที่รวมไม่ครบ 100 ถูกปรับให้ครบโดยรักษาอัตราส่วน", () => {
    const g = goalFromPercent(2000, 40, 30, 20); // รวม 90
    const split = goalSplit(g);
    expect(split.carbPct + split.proteinPct + split.fatPct).toBe(100);
    // อัตราส่วนเดิม 40:30:20 = 4:3:2 → ประมาณ 44:33:22
    expect(split.carbPct).toBe(44);
    expect(split.proteinPct).toBe(33);
  });

  it("สัดส่วนเริ่มต้นคิดเป็น 50:20:30", () => {
    expect(DEFAULT_SPLIT).toEqual({ carbPct: 50, proteinPct: 20, fatPct: 30 });
  });
});

describe("goalFromGrams", () => {
  it("คำนวณ kcal จากกรัมด้วย Atwater", () => {
    // 180*4 + 135*4 + 60*9 = 720 + 540 + 540 = 1800
    expect(goalFromGrams(180, 135, 60)).toEqual({ kcal: 1800, carbG: 180, proteinG: 135, fatG: 60 });
  });
});

describe("goalSplit", () => {
  it("% รวมได้ 100 พอดีเสมอ แม้ปัดเศษ", () => {
    for (const g of [goalFromGrams(133, 77, 41), goalFromGrams(1, 1, 1), goalFromPercent(1234, 33, 33, 33)]) {
      const s = goalSplit(g);
      expect(s.carbPct + s.proteinPct + s.fatPct).toBe(100);
    }
  });

  it("เป้าว่างเปล่า → 0 ทั้งหมด ไม่ใช่ NaN", () => {
    expect(goalSplit({ kcal: 0, carbG: 0, proteinG: 0, fatG: 0 })).toEqual({
      carbPct: 0, proteinPct: 0, fatPct: 0,
    });
  });
});

describe("computeProgress", () => {
  const goal = goalFromPercent(1800, 50, 20, 30); // C225 P90 F60

  it("บอกทั้งกรัม kcal % และเหลืออีกเท่าไร", () => {
    const p = computeProgress(goal, { kcal: 1205, carbG: 84, proteinG: 55, fatG: 72 });

    expect(p.kcal).toMatchObject({ eatenKcal: 1205, goalKcal: 1800, leftKcal: 595, pct: 67, over: false });
    expect(p.carb).toMatchObject({ eatenG: 84, goalG: 225, leftG: 141, eatenKcal: 336, goalKcal: 900, pct: 37 });
    expect(p.protein).toMatchObject({ eatenG: 55, goalG: 90, leftG: 35, pct: 61 });
  });

  it("เกินเป้า → leftG ติดลบ · pct เกิน 100 · over = true (ห้ามตัดเพดาน)", () => {
    const p = computeProgress(goal, { kcal: 2000, carbG: 100, proteinG: 60, fatG: 72 });
    expect(p.fat.over).toBe(true);
    expect(p.fat.leftG).toBe(-12);
    expect(p.fat.pct).toBe(120);
    expect(p.fat.leftKcal).toBe(-108); // 12g ไขมัน × 9
    expect(p.kcal.over).toBe(true);
  });

  it("kcal ของแต่ละมาโครสอดคล้องกับกรัมเสมอ (Atwater)", () => {
    const p = computeProgress(goal, { kcal: 900, carbG: 50, proteinG: 40, fatG: 30 });
    expect(p.carb.eatenKcal).toBe(50 * 4);
    expect(p.protein.eatenKcal).toBe(40 * 4);
    expect(p.fat.eatenKcal).toBe(30 * 9);
    expect(p.carb.goalKcal).toBe(225 * 4);
  });

  it("รายงานผลรวม Atwater ของเป้าไว้ตรวจความไม่สอดคล้อง", () => {
    // ตั้งกรัมเองแบบไม่พอดี: 100*4 + 100*4 + 100*9 = 1700 ≠ kcal ที่คำนวณให้
    const odd = goalFromGrams(100, 100, 100);
    const p = computeProgress(odd, { kcal: 0, carbG: 0, proteinG: 0, fatG: 0 });
    expect(p.macroKcalTotal).toBe(1700);
    expect(p.goal.kcal).toBe(1700); // goalFromGrams คำนวณให้ตรงกันอยู่แล้ว
  });

  it("ยังไม่กินอะไร → 0% และเหลือเต็มเป้า", () => {
    const p = computeProgress(goal, { kcal: 0, carbG: 0, proteinG: 0, fatG: 0 });
    expect(p.kcal.pct).toBe(0);
    expect(p.kcal.leftKcal).toBe(1800);
    expect(p.carb.leftG).toBe(225);
    expect(p.kcal.over).toBe(false);
  });
});

// ── คำสั่งในไลน์ ───────────────────────────────────────────────────────────────
describe("parseMealIntent — เป้าหมาย", () => {
  it("เป้ากิน <แคล> → ใช้สัดส่วนเริ่มต้น", () => {
    expect(parseMealIntent("เป้ากิน 1800", NOW)).toEqual({
      action: "set_goal", kcal: 1800, carbG: 225, proteinG: 90, fatG: 60,
    });
  });

  it("มีแคลอรี่ + C/P/F → ตีเป็น %", () => {
    expect(parseMealIntent("เป้ากิน 1800 C40 P30 F30", NOW)).toEqual({
      action: "set_goal", kcal: 1800, carbG: 180, proteinG: 135, fatG: 60,
    });
  });

  it("ไม่มีแคลอรี่ + C/P/F → ตีเป็นกรัม (คิดแคลอรี่ให้)", () => {
    expect(parseMealIntent("เป้ากิน C180 P135 F60", NOW)).toEqual({
      action: "set_goal", kcal: 1800, carbG: 180, proteinG: 135, fatG: 60,
    });
  });

  it("สองแบบข้างบนต้องได้ผลเท่ากัน (1800 @ 40/30/30 = C180 P135 F60)", () => {
    expect(parseMealIntent("เป้ากิน 1800 C40 P30 F30", NOW)).toEqual(
      parseMealIntent("เป้ากิน C180 P135 F60", NOW)
    );
  });

  it("รูปย่อสัดส่วน 50:20:30", () => {
    expect(parseMealIntent("เป้ากิน 2000 50:20:30", NOW)).toMatchObject({
      action: "set_goal", kcal: 2000, carbG: 250, proteinG: 100,
    });
  });

  it("คำไทยเต็ม", () => {
    expect(parseMealIntent("ตั้งเป้า 1500 คาร์บ 45 โปรตีน 25 ไขมัน 30", NOW)).toMatchObject({
      action: "set_goal", kcal: 1500,
    });
  });

  it("ดูเป้า / เป้า / เหลือกินได้ → show_goal (ระบุวันได้)", () => {
    for (const c of ["ดูเป้า", "เป้า", "เหลือกินได้"]) {
      expect(parseMealIntent(c, NOW)).toEqual({ action: "show_goal", occurredOn: "2026-08-04" });
    }
    expect(parseMealIntent("ดูเป้า เมื่อวาน", NOW)).toEqual({
      action: "show_goal", occurredOn: "2026-08-03",
    });
  });

  it("ลบเป้า", () => {
    expect(parseMealIntent("ลบเป้า", NOW)).toEqual({ action: "clear_goal" });
  });

  it("ไม่ไปชนคำสั่งบันทึกอาหาร", () => {
    expect(parseMealIntent("กิน เช้า\nข้าวสวย 100g", NOW)).toMatchObject({ action: "record" });
  });
});

// ── การ์ด ──────────────────────────────────────────────────────────────────────
describe("การ์ดเป้าหมาย", () => {
  const goal = goalFromPercent(1800, 50, 20, 30);
  const flat = (o: unknown) => JSON.stringify(o);

  it("การ์ดบอก 'เหลือกินได้อีก' เป็นพาดหัว", () => {
    const card = buildGoalCard(computeProgress(goal, { kcal: 1205, carbG: 84, proteinG: 55, fatG: 72 }), "2026-08-04", 9);
    const s = flat(card.contents);
    expect(s).toContain("เหลือกินได้อีก");
    expect(s).toContain("595 kcal");
    expect(card.altText).toContain("เหลือ 595 kcal");
  });

  it("เกินเป้า → พาดหัวเปลี่ยนเป็น 'เกินเป้าแล้ว'", () => {
    const card = buildGoalCard(computeProgress(goal, { kcal: 2200, carbG: 250, proteinG: 100, fatG: 80 }), "2026-08-04", 12);
    expect(flat(card.contents)).toContain("เกินเป้าแล้ว");
    expect(card.altText).toContain("เกิน 400 kcal");
  });

  it("ทุกแถวมีทั้งกรัมและ kcal", () => {
    const s = flat(buildGoalCard(computeProgress(goal, { kcal: 900, carbG: 100, proteinG: 50, fatG: 30 }), "2026-08-04", 5).contents);
    expect(s).toContain("100 / 225 g"); // กรัม
    expect(s).toContain("400/900 kcal"); // kcal ของคาร์บ
  });

  it("ยืนยันตอนตั้งเป้าบอกครบทั้งกรัม kcal และ %", () => {
    const t = buildGoalSetText(goal).text ?? "";
    expect(t).toContain("225 g");
    expect(t).toContain("900 kcal");
    expect(t).toContain("50%");
  });

  it("ยังไม่ตั้งเป้า → บอกวิธีตั้งครบทั้ง 3 แบบ", () => {
    const t = buildNoGoalText().text ?? "";
    expect(t).toContain("เป้ากิน 1800");
    expect(t).toContain("C40 P30 F30");
    expect(t).toContain("C180 P135 F60");
  });
});
