import { describe, it, expect } from "vitest";
import { parseMealIntent, parseFoodLine, inferSlot, extractDate } from "../lib/modules/meal-tracker/parse";
import {
  computeLineMacros,
  macroSplit,
  scaleFactor,
  sumMacros,
  type FoodRef,
} from "../lib/modules/meal-tracker/macros";
import { aggregateDay, formatThaiDate } from "../lib/modules/meal-tracker/summary";
import { macroChartUrl, parseMacroParams } from "../lib/modules/meal-tracker/chart-url";
import { renderDonutPng } from "../lib/modules/meal-tracker/donut";
import type { MealEntryRow } from "../lib/modules/meal-tracker/store";

/**
 * Meal Tracker — เทสต์เฉพาะส่วนที่ PURE (parser / คณิตมาโคร / สรุป / URL กราฟ / เรนเดอร์โดนัท).
 * ไม่มีการแตะ DB เลย จึงล็อกพฤติกรรมได้แน่นอน.
 *
 * เวลาอ้างอิงตลอดไฟล์: 2026-08-04 09:15 น. เวลาไทย = 2026-08-04T02:15:00Z
 */
const NOW = new Date("2026-08-04T02:15:00Z");

// ── parser: บรรทัดรายการอาหาร ───────────────────────────────────────────────────
describe("parseFoodLine", () => {
  it("อ่านน้ำหนักเป็นกรัมได้ทุกหน่วย (g / กรัม / ขีด / กก. / ml)", () => {
    expect(parseFoodLine("อกไก่ 150g")).toMatchObject({ name: "อกไก่", qty: 150, unit: "g" });
    expect(parseFoodLine("อกไก่ 150 กรัม")).toMatchObject({ qty: 150, unit: "g" });
    expect(parseFoodLine("อกไก่ 2 ขีด")).toMatchObject({ qty: 200, unit: "g" });
    expect(parseFoodLine("ข้าว 1.5 ขีด")).toMatchObject({ qty: 150, unit: "g" });
    expect(parseFoodLine("นมสด 200 ml")).toMatchObject({ qty: 200, unit: "g" });
    expect(parseFoodLine("เนื้อ 1 กก.")).toMatchObject({ qty: 1000, unit: "g" });
  });

  it("อ่านหน่วยนับชิ้นได้ รวมหน่วยที่ฐานอาหารใช้จริง (ฟอง/ทัพพี/ผล/จาน)", () => {
    expect(parseFoodLine("ไข่ต้ม 2 ฟอง")).toMatchObject({ name: "ไข่ต้ม", qty: 2, unit: "unit", unitLabel: "ฟอง" });
    expect(parseFoodLine("ข้าวสวย 1 ทัพพี")).toMatchObject({ name: "ข้าวสวย", qty: 1, unitLabel: "ทัพพี" });
    // "ผล" เคยตกหล่นจาก COUNT_UNITS ทำให้ผลไม้ทุกตัวแยกจำนวนไม่ออก — ล็อกไว้กันหลุดอีก
    expect(parseFoodLine("กล้วยน้ำว้า 2 ผล")).toMatchObject({ name: "กล้วยน้ำว้า", qty: 2, unitLabel: "ผล" });
    expect(parseFoodLine("ข้าวมันไก่ 1 จาน")).toMatchObject({ name: "ข้าวมันไก่", qty: 1, unitLabel: "จาน" });
  });

  it("อ่านเศษส่วนได้ทั้งแบบคำและขีดทับ ไม่ว่าอยู่ตำแหน่งไหนของบรรทัด", () => {
    expect(parseFoodLine("ส้มตำไทย ครึ่งจาน")).toMatchObject({ name: "ส้มตำไทย", qty: 0.5, unitLabel: "จาน" });
    expect(parseFoodLine("ข้าวครึ่งทัพพี")).toMatchObject({ name: "ข้าว", qty: 0.5, unitLabel: "ทัพพี" });
    expect(parseFoodLine("ข้าวมันไก่ 1/2 จาน")).toMatchObject({ name: "ข้าวมันไก่", qty: 0.5, unitLabel: "จาน" });
    expect(parseFoodLine("ข้าวสวย 3/4 ทัพพี")).toMatchObject({ qty: 0.75 });
  });

  it("ไม่ระบุจำนวน = 1 หน่วยเสิร์ฟ", () => {
    expect(parseFoodLine("ข้าวสวย")).toMatchObject({ name: "ข้าวสวย", qty: 1, unit: "unit" });
  });

  it("กวาดจำนวน/หน่วยที่ค้างอยู่ออกจากชื่อ เพื่อไม่ให้ค้นฐานอาหารเพี้ยน", () => {
    expect(parseFoodLine("นมสด 1 กล่อง 250ml")).toMatchObject({ name: "นมสด", qty: 250, unit: "g" });
  });

  it("บรรทัดที่มีแต่ตัวเลข → ข้าม (ไม่บันทึกขยะ)", () => {
    expect(parseFoodLine("100")).toBeNull();
    expect(parseFoodLine("   ")).toBeNull();
  });
});

// ── parser: intent ──────────────────────────────────────────────────────────────
describe("parseMealIntent", () => {
  it("อ่านหัวข้อความ 'กิน <มื้อ> <วันที่>' แล้วไล่รายการทีละบรรทัด", () => {
    const r = parseMealIntent("กิน เช้า วันที่ 3 Aug\nข้าวสวย 100g\nไข่ต้ม 2 ฟอง\nอกไก่ 150g", NOW);
    expect(r).toMatchObject({ action: "record", slot: "breakfast", slotExplicit: true, occurredOn: "2026-08-03" });
    expect(r && r.action === "record" && r.items.map((i) => i.name)).toEqual(["ข้าวสวย", "ไข่ต้ม", "อกไก่"]);
  });

  it("รับรายการบนบรรทัดเดียวกับ 'กิน' และคั่นด้วยจุลภาคได้", () => {
    const r = parseMealIntent("กิน เที่ยง ข้าวมันไก่ 1 จาน, ชาเขียวไม่หวาน 1 แก้ว", NOW);
    expect(r).toMatchObject({ action: "record", slot: "lunch" });
    expect(r && r.action === "record" && r.items).toHaveLength(2);
  });

  it("ไม่ระบุมื้อ → เดาจากเวลาไทย และตั้งธง slotExplicit=false ไว้บอกผู้ใช้", () => {
    const r = parseMealIntent("กิน\nข้าวสวย 1 ทัพพี", NOW); // 09:15 น.
    expect(r).toMatchObject({ action: "record", slot: "breakfast", slotExplicit: false });
  });

  it("รองรับวันที่ทั้งไทย/อังกฤษ/สัมพัทธ์ และปี พ.ศ. 2 หลัก", () => {
    expect(parseMealIntent("กิน เย็น 3 ส.ค. 69\nไก่ย่าง 1 ชิ้น", NOW)).toMatchObject({ occurredOn: "2026-08-03" });
    expect(parseMealIntent("กิน เมื่อวาน\nข้าวสวย", NOW)).toMatchObject({ occurredOn: "2026-08-03" });
    expect(parseMealIntent("กิน วานซืน\nข้าวสวย", NOW)).toMatchObject({ occurredOn: "2026-08-02" });
    expect(parseMealIntent("สรุปกิน 3 ส.ค.", NOW)).toMatchObject({ action: "day_summary", occurredOn: "2026-08-03" });
  });

  it("แยกคำสั่งอื่น ๆ ได้ครบ", () => {
    expect(parseMealIntent("สรุปกิน", NOW)).toMatchObject({ action: "day_summary", occurredOn: "2026-08-04" });
    expect(parseMealIntent("ลบกิน", NOW)).toMatchObject({ action: "undo" });
    expect(parseMealIntent("วิธีกิน", NOW)).toMatchObject({ action: "help" });
    expect(parseMealIntent("อาหาร ข้าวสวย", NOW)).toMatchObject({ action: "lookup", name: "ข้าวสวย" });
  });

  it("สอนอาหาร: อ่าน C/P/F + ฐาน (ต่อจาน / ต่อ 100g) + น้ำหนักต่อหน่วย", () => {
    expect(parseMealIntent("สอนอาหาร ข้าวมันไก่เจ๊แดง = C78 P28 F22 ต่อจาน 350g", NOW)).toMatchObject({
      action: "teach",
      name: "ข้าวมันไก่เจ๊แดง",
      carb: 78,
      protein: 28,
      fat: 22,
      basis: "per_serving",
      unitLabel: "จาน",
      unitGrams: 350,
    });
    expect(parseMealIntent("สอนอาหาร อกไก่หมัก = C 2 P 30 F 4 ต่อ 100g", NOW)).toMatchObject({
      basis: "per_100g",
    });
    expect(parseMealIntent("สอนอาหาร โปรตีนบาร์ = คาร์บ 20 โปรตีน 15 ไขมัน 8", NOW)).toMatchObject({
      carb: 20,
      protein: 15,
      fat: 8,
    });
  });

  it("ไม่แตะข้อความของโมดูลอื่น หรือบทสนทนาทั่วไป (คืน null → บอทเงียบ)", () => {
    expect(parseMealIntent("สวัสดีครับ", NOW)).toBeNull();
    expect(parseMealIntent("จด กาแฟ 50", NOW)).toBeNull(); // ledger
    expect(parseMealIntent("เพิ่ม ประชุมพรุ่งนี้", NOW)).toBeNull(); // todo
    expect(parseMealIntent("ลบ 2", NOW)).toBeNull(); // todo delete — ต้องไม่ชนกับ "ลบกิน"
    expect(parseMealIntent("", NOW)).toBeNull();
  });
});

describe("inferSlot", () => {
  const at = (hhmm: string) => new Date(`2026-08-04T${hhmm}:00Z`); // UTC → +7 = เวลาไทย
  it("เดามื้อจากเวลาไทย", () => {
    expect(inferSlot(at("01:00"))).toBe("breakfast"); // 08:00
    expect(inferSlot(at("05:00"))).toBe("lunch"); // 12:00
    expect(inferSlot(at("11:00"))).toBe("dinner"); // 18:00
    expect(inferSlot(at("16:00"))).toBe("snack"); // 23:00
  });
});

describe("extractDate", () => {
  it("ตัดคำว่า 'วันที่' ทิ้งก่อนเสมอ", () => {
    const today = { y: 2026, m: 8, d: 4 };
    expect(extractDate("วันที่ 3 Aug", today).ymd).toEqual({ y: 2026, m: 8, d: 3 });
  });
});

// ── คณิตมาโคร ───────────────────────────────────────────────────────────────────
const RICE: FoodRef = {
  id: "f1", name: "ข้าวสวย", basis: "per_100g", unitLabel: "ทัพพี", unitGrams: 60,
  kcal: 126, carbG: 28, proteinG: 2.7, fatG: 0.3, source: "seed-approx",
};
const EGG: FoodRef = {
  id: "f2", name: "ไข่ต้ม", basis: "per_serving", unitLabel: "ฟอง", unitGrams: 50,
  kcal: 75, carbG: 0.6, proteinG: 6.3, fatG: 5.3, source: "seed-approx",
};

describe("scaleFactor", () => {
  it("per_100g + กรัม → grams/100", () => {
    expect(scaleFactor({ name: "", qty: 150, unit: "g", unitLabel: null, raw: "" }, RICE)).toEqual({
      factor: 1.5,
      grams: 150,
    });
  });

  it("per_100g + หน่วย → แปลงเป็นกรัมด้วย unitGrams ก่อน", () => {
    expect(scaleFactor({ name: "", qty: 2, unit: "unit", unitLabel: "ทัพพี", raw: "" }, RICE)).toEqual({
      factor: 1.2,
      grams: 120,
    });
  });

  it("per_serving + หน่วย → คูณตรง ๆ", () => {
    expect(scaleFactor({ name: "", qty: 2, unit: "unit", unitLabel: "ฟอง", raw: "" }, EGG)).toEqual({
      factor: 2,
      grams: 100,
    });
  });

  it("per_serving + กรัม → หารด้วยน้ำหนักต่อหน่วย", () => {
    expect(scaleFactor({ name: "", qty: 100, unit: "g", unitLabel: null, raw: "" }, EGG)).toEqual({
      factor: 2,
      grams: 100,
    });
  });
});

describe("computeLineMacros", () => {
  it("คิดพลังงานจากมาโครแบบ Atwater เสมอ (4-4-9) ไม่ใช่หยิบ kcal ในฐานมาคูณ", () => {
    const m = computeLineMacros({ name: "ข้าวสวย", qty: 150, unit: "g", unitLabel: null, raw: "" }, RICE);
    expect(m.carbG).toBe(42);
    expect(m.proteinG).toBe(4.1); // 2.7 × 1.5 = 4.05 → ปัด 1 ตำแหน่ง
    expect(m.fatG).toBe(0.5); // 0.3 × 1.5 = 0.45 → 0.5
    expect(m.kcal).toBe(Math.round(42 * 4 + 4.1 * 4 + 0.5 * 9));
    expect(m.grams).toBe(150);
  });

  it("ไข่ต้ม 2 ฟอง = สองเท่าของหนึ่งฟอง", () => {
    const m = computeLineMacros({ name: "ไข่ต้ม", qty: 2, unit: "unit", unitLabel: "ฟอง", raw: "" }, EGG);
    expect(m).toMatchObject({ carbG: 1.2, proteinG: 12.6, fatG: 10.6, grams: 100 });
  });
});

describe("macroSplit", () => {
  it("รวมกันได้ 100% เสมอ (ปัดแบบ largest remainder)", () => {
    for (const m of [
      { kcal: 0, carbG: 33.3, proteinG: 33.3, fatG: 14.8 },
      { kcal: 0, carbG: 72.4, proteinG: 38.1, fatG: 19 },
      { kcal: 0, carbG: 1, proteinG: 1, fatG: 1 },
      { kcal: 0, carbG: 100, proteinG: 20, fatG: 0.4 },
    ]) {
      const s = macroSplit(m);
      expect(s.carbPct + s.proteinPct + s.fatPct).toBe(100);
    }
  });

  it("ไม่มีสารอาหารเลย → 0/0/0 (ไม่หารด้วยศูนย์)", () => {
    expect(macroSplit({ kcal: 0, carbG: 0, proteinG: 0, fatG: 0 })).toEqual({
      carbPct: 0, proteinPct: 0, fatPct: 0, atwaterKcal: 0,
    });
  });

  it("โปรตีนล้วน → 100% โปรตีน", () => {
    expect(macroSplit({ kcal: 0, carbG: 0, proteinG: 25, fatG: 0 })).toMatchObject({ proteinPct: 100 });
  });
});

describe("sumMacros", () => {
  it("รวมหลายรายการแล้วปัดทศนิยม 1 ตำแหน่ง", () => {
    expect(
      sumMacros([
        { kcal: 126, carbG: 28, proteinG: 2.7, fatG: 0.3 },
        { kcal: 150, carbG: 1.2, proteinG: 12.6, fatG: 10.6 },
      ])
    ).toEqual({ kcal: 276, carbG: 29.2, proteinG: 15.3, fatG: 10.9 });
  });
});

// ── สรุปทั้งวัน ──────────────────────────────────────────────────────────────────
function row(over: Partial<MealEntryRow>): MealEntryRow {
  return {
    id: "e", target_id: "t", line_user_id: "u", occurred_on: "2026-08-03", meal_slot: "breakfast",
    food_id: "f", food_name: "ข้าวสวย", qty: 1, qty_unit: "unit", grams: 100,
    kcal: 100, carb_g: 20, protein_g: 5, fat_g: 0, resolved: true, raw_text: null,
    created_at: "2026-08-03T01:00:00Z", ...over,
  };
}

describe("aggregateDay", () => {
  it("รวมทั้งวัน + แยกตามมื้อ ตามลำดับ เช้า→กลางวัน→เย็น→ว่าง", () => {
    const s = aggregateDay([
      row({ meal_slot: "dinner", kcal: 300, carb_g: 40, protein_g: 20, fat_g: 10 }),
      row({ meal_slot: "breakfast" }),
      row({ meal_slot: "lunch", kcal: 200, carb_g: 30, protein_g: 10, fat_g: 5 }),
    ]);
    expect(s.count).toBe(3);
    expect(s.total).toMatchObject({ carbG: 90, proteinG: 35, fatG: 15 });
    expect(s.bySlot.map((b) => b.slot)).toEqual(["breakfast", "lunch", "dinner"]);
    expect(s.split.carbPct + s.split.proteinPct + s.split.fatPct).toBe(100);
  });

  it("เก็บชื่ออาหารที่ยังไม่รู้จักไว้เตือน (ไม่ซ้ำ) — ยอดรวมห้ามขาดแบบเงียบ ๆ", () => {
    const s = aggregateDay([
      row({ resolved: false, food_name: "ก๋วยจั๊บ", kcal: 0, carb_g: 0, protein_g: 0, fat_g: 0 }),
      row({ resolved: false, food_name: "ก๋วยจั๊บ", kcal: 0, carb_g: 0, protein_g: 0, fat_g: 0 }),
      row({ resolved: false, food_name: "พิซซ่า", kcal: 0, carb_g: 0, protein_g: 0, fat_g: 0 }),
    ]);
    expect(s.unresolvedNames).toEqual(["ก๋วยจั๊บ", "พิซซ่า"]);
    expect(s.total.kcal).toBe(0);
  });

  it("ไม่มีรายการ → นับ 0 และไม่พัง", () => {
    expect(aggregateDay([])).toMatchObject({ count: 0, bySlot: [], unresolvedNames: [] });
  });
});

describe("formatThaiDate", () => {
  it("แปลงเป็นวันไทย + ปี พ.ศ. 2 หลัก", () => {
    expect(formatThaiDate("2026-08-03")).toBe("จ. 3 ส.ค. 69");
    expect(formatThaiDate("2026-01-01")).toBe("พฤ. 1 ม.ค. 69");
  });
  it("รูปแบบผิด → คืนค่าเดิม ไม่โยน error", () => {
    expect(formatThaiDate("nope")).toBe("nope");
  });
});

// ── URL กราฟ ────────────────────────────────────────────────────────────────────
describe("chart-url", () => {
  it("ค่าชุดเดิม → URL เดิมเป๊ะ (แคชได้)", () => {
    expect(macroChartUrl(72.44, 38.1, 19)).toBe(macroChartUrl(72.4, 38.1, 19.0));
    expect(macroChartUrl(72.4, 38.1, 19)).toContain("c=72.4&p=38.1&f=19");
  });

  it("อ่าน query กลับได้ และปฏิเสธค่าที่ใช้ไม่ได้", () => {
    expect(parseMacroParams(new URLSearchParams("c=10&p=5&f=2"))).toMatchObject({
      carbG: 10, proteinG: 5, fatG: 2, size: 420,
    });
    expect(parseMacroParams(new URLSearchParams(""))).toMatchObject({ carbG: 0, proteinG: 0, fatG: 0 });
    expect(parseMacroParams(new URLSearchParams("c=-1"))).toBeNull();
    expect(parseMacroParams(new URLSearchParams("c=abc"))).toBeNull();
    expect(parseMacroParams(new URLSearchParams("c=1e99"))).toBeNull();
  });

  it("บีบขนาดรูปให้อยู่ในกรอบ (กันยิงขอรูปยักษ์ทำเซิร์ฟเวอร์พัง)", () => {
    expect(parseMacroParams(new URLSearchParams("c=1&s=99999"))?.size).toBe(720);
    expect(parseMacroParams(new URLSearchParams("c=1&s=1"))?.size).toBe(64);
  });
});

// ── เรนเดอร์โดนัท ────────────────────────────────────────────────────────────────
describe("renderDonutPng", () => {
  it("คืน PNG จริง (ลายเซ็นไฟล์ถูกต้อง) ทุกกรณี รวมกรณีไม่มีข้อมูล", async () => {
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const segs of [
      [{ value: 290, color: "#F59E0B" }, { value: 152, color: "#0EA5E9" }, { value: 171, color: "#A855F7" }],
      [{ value: 100, color: "#F59E0B" }],
      [],
      [{ value: 400, color: "#F59E0B" }, { value: 0, color: "#0EA5E9" }, { value: 3.6, color: "#A855F7" }],
    ]) {
      const png = await renderDonutPng(segs, { size: 120 });
      expect(png.subarray(0, 4)).toEqual(PNG_SIG);
      expect(png.length).toBeGreaterThan(100);
    }
  });

  it("ตัดค่าติดลบ/NaN ทิ้ง แทนที่จะวาดเพี้ยน", async () => {
    const png = await renderDonutPng(
      [{ value: -5, color: "#F59E0B" }, { value: NaN, color: "#0EA5E9" }, { value: 10, color: "#A855F7" }],
      { size: 96 }
    );
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
