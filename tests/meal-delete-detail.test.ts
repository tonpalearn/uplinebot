import { describe, it, expect } from "vitest";
import { parseMealIntent } from "../lib/modules/meal-tracker/parse";
import { buildDayDetailCard, buildDeletedText, buildRestoredText } from "../lib/modules/meal-tracker/flex";
import type { MealEntryRow } from "../lib/modules/meal-tracker/store";

/**
 * คำสั่งลบแบบเจาะจง + การ์ด "กินอะไรไปบ้าง".
 *
 * จุดที่ต้องล็อกไว้แน่น: **เลขที่แสดงบนการ์ดรายละเอียด = เลขที่ใช้พิมพ์ลบ** ถ้าสองอันนี้
 * หลุดจากกันเมื่อไหร่ ผู้ใช้จะลบผิดรายการโดยไม่รู้ตัว — เทสต์ชุดนี้จึงยึด "ลำดับตามเวลาบันทึก
 * ทั้งวัน ไม่รีเซ็ตรายมื้อ" เป็นสัญญาระหว่าง parse / flex / store.
 */

const NOW = new Date("2026-08-04T05:00:00Z"); // 12:00 น. เวลาไทย

function row(over: Partial<MealEntryRow> = {}): MealEntryRow {
  return {
    id: "r1", target_id: "t1", line_user_id: "u1", occurred_on: "2026-08-04",
    meal_slot: "breakfast", food_id: "f1", food_name: "ข้าวสวย", qty: 1, qty_unit: "unit",
    grams: 100, kcal: 130, carb_g: 28, protein_g: 2.7, fat_g: 0.3, resolved: true,
    food_source: "seed-approx", raw_text: "ข้าวสวย 1 ทัพพี", created_at: "2026-08-04T01:00:00Z",
    ...over,
  };
}

// ── ลบแบบเจาะจง ───────────────────────────────────────────────────────────────
describe("parseMealIntent — ลบรายการ", () => {
  it("ลบกิน (เปล่า ๆ) = ลบล่าสุด ยังทำงานเหมือนเดิม", () => {
    expect(parseMealIntent("ลบกิน", NOW)).toEqual({ action: "undo" });
  });

  it("ลบกิน 3 = ลบรายการที่ 3 ของวันนี้", () => {
    expect(parseMealIntent("ลบกิน 3", NOW)).toEqual({
      action: "delete_items", occurredOn: "2026-08-04", indexes: [3],
    });
  });

  it("ลบหลายรายการพร้อมกันได้ทั้งคอมมาและเว้นวรรค", () => {
    expect(parseMealIntent("ลบกิน 2,3", NOW)).toMatchObject({ indexes: [2, 3] });
    expect(parseMealIntent("ลบกิน 1 4", NOW)).toMatchObject({ indexes: [1, 4] });
  });

  it("เลขซ้ำถูกยุบเหลือตัวเดียว (กันลบซ้อน)", () => {
    expect(parseMealIntent("ลบกิน 2,2,3", NOW)).toMatchObject({ indexes: [2, 3] });
  });

  it("ลบกิน เช้า = ลบทั้งมื้อ", () => {
    expect(parseMealIntent("ลบกิน เช้า", NOW)).toEqual({
      action: "delete_day", occurredOn: "2026-08-04", slot: "breakfast",
    });
  });

  it("ลบกินทั้งวัน / ลบกินวันนี้ = ลบทุกรายการของวัน", () => {
    expect(parseMealIntent("ลบกินทั้งวัน", NOW)).toEqual({
      action: "delete_day", occurredOn: "2026-08-04", slot: null,
    });
    expect(parseMealIntent("ลบกิน ทั้งหมด", NOW)).toMatchObject({ action: "delete_day", slot: null });
  });

  it("ระบุวันที่ย้อนหลังได้ — ลบกิน เย็น เมื่อวาน", () => {
    expect(parseMealIntent("ลบกิน เย็น เมื่อวาน", NOW)).toEqual({
      action: "delete_day", occurredOn: "2026-08-03", slot: "dinner",
    });
  });

  it("กู้กิน = คืนการลบครั้งล่าสุด", () => {
    expect(parseMealIntent("กู้กิน", NOW)).toEqual({ action: "restore" });
    expect(parseMealIntent("เลิกลบกิน", NOW)).toEqual({ action: "restore" });
  });

  it("อาร์กิวเมนต์ที่อ่านไม่ออก → help ไม่ใช่ลบมั่ว", () => {
    expect(parseMealIntent("ลบกิน อะไรสักอย่าง", NOW)).toEqual({ action: "help" });
  });
});

// ── รายละเอียดรายมื้อ ─────────────────────────────────────────────────────────
describe("parseMealIntent — รายละเอียด", () => {
  it("รับได้หลายคำ", () => {
    for (const cmd of ["รายละเอียดกิน", "รายการกิน", "กินอะไรบ้าง", "กินอะไรไปบ้าง"]) {
      expect(parseMealIntent(cmd, NOW)).toEqual({ action: "day_detail", occurredOn: "2026-08-04" });
    }
  });

  it("ดูย้อนหลังได้", () => {
    expect(parseMealIntent("รายละเอียดกิน เมื่อวาน", NOW)).toEqual({
      action: "day_detail", occurredOn: "2026-08-03",
    });
  });

  it("ไม่ไปชนคำสั่งบันทึก — 'กิน ข้าวสวย' ยังเป็น record", () => {
    expect(parseMealIntent("กิน ข้าวสวย 100g", NOW)).toMatchObject({ action: "record" });
  });
});

// ── การ์ดรายละเอียด ───────────────────────────────────────────────────────────
describe("buildDayDetailCard", () => {
  const rows = [
    row({ id: "a", meal_slot: "breakfast", food_name: "ข้าวสวย", created_at: "2026-08-04T01:00:00Z" }),
    row({ id: "b", meal_slot: "breakfast", food_name: "ไข่ต้ม", kcal: 155, created_at: "2026-08-04T01:01:00Z" }),
    row({ id: "c", meal_slot: "lunch", food_name: "ก๋วยจั๊บ", kcal: 493, food_source: "ai-estimate", created_at: "2026-08-04T05:00:00Z" }),
  ];

  const flat = (o: unknown): string => JSON.stringify(o);

  it("ลิสต์ทุกรายการพร้อมเลขกำกับต่อเนื่องทั้งวัน (ไม่รีเซ็ตรายมื้อ)", () => {
    const card = buildDayDetailCard(rows, "2026-08-04");
    const s = flat(card.contents);
    expect(s).toContain("ข้าวสวย");
    expect(s).toContain("ไข่ต้ม");
    expect(s).toContain("ก๋วยจั๊บ");
    // ก๋วยจั๊บ อยู่มื้อกลางวันแต่เป็นรายการที่ 3 ของวัน — ต้องเป็น "3." ไม่ใช่ "1."
    expect(s).toContain('"3."');
  });

  it("ติดป้าย 🤖 ให้รายการที่ค่ามาจาก AI", () => {
    expect(flat(buildDayDetailCard(rows, "2026-08-04").contents)).toContain("🤖 ก๋วยจั๊บ");
  });

  it("บอกวิธีลบไว้บนการ์ด (ผู้ใช้ไม่ต้องจำคำสั่ง)", () => {
    const s = flat(buildDayDetailCard(rows, "2026-08-04").contents);
    expect(s).toContain("ลบกิน 2");
    expect(s).toContain("กู้กิน");
  });

  it("รวมพลังงานทั้งวันถูกต้อง", () => {
    expect(buildDayDetailCard(rows, "2026-08-04").altText).toContain("778"); // 130+155+493
  });

  it("วันที่ไม่มีข้อมูล → ข้อความชวนเริ่มบันทึก ไม่ใช่การ์ดเปล่า", () => {
    const card = buildDayDetailCard([], "2026-08-04");
    expect(card.type).toBe("text");
    expect(card.text).toContain("ยังไม่มีบันทึกอาหาร");
  });
});

// ── ข้อความยืนยันลบ/กู้คืน ─────────────────────────────────────────────────────
describe("buildDeletedText / buildRestoredText", () => {
  it("บอกจำนวน ชื่อ และวิธีเอากลับคืน", () => {
    const msg = buildDeletedText([row({ food_name: "ข้าวสวย" }), row({ food_name: "ไข่ต้ม", kcal: 155 })], "2026-08-04");
    expect(msg.text).toContain("ลบแล้ว 2 รายการ");
    expect(msg.text).toContain("ข้าวสวย");
    expect(msg.text).toContain("กู้กิน");
    expect(msg.text).toContain("285"); // 130 + 155
  });

  it("ไม่มีอะไรให้ลบ → บอกตรง ๆ ไม่ใช่เงียบ", () => {
    expect(buildDeletedText([], "2026-08-04").text).toContain("ไม่มีรายการให้ลบ");
  });

  it("กู้คืนแล้วบอกว่าได้อะไรกลับมา", () => {
    expect(buildRestoredText([row()]).text).toContain("กู้คืนแล้ว 1 รายการ");
  });

  it("ไม่มีอะไรให้กู้ → บอกข้อจำกัด 24 ชม. ด้วย", () => {
    expect(buildRestoredText([]).text).toContain("24 ชม.");
  });
});
