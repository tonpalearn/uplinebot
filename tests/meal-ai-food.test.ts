import { describe, it, expect } from "vitest";
import { validateEstimate } from "../lib/modules/meal-tracker/ai-food";

/**
 * ด่านตรวจค่าที่ AI ประเมินมา — ชั้นที่กันไม่ให้ "ตัวเลขมั่ว" หลุดขึ้นการ์ดโค้ชชิ่ง.
 * ทดสอบล้วน ๆ ไม่เรียก API จริง (validateEstimate เป็นฟังก์ชัน pure).
 *
 * หลักที่เทสต์ชุดนี้ล็อกไว้: **สงสัยเมื่อไหร่ = ทิ้ง** — คืน null แล้วให้ระบบตกกลับไปทาง
 * "ยังไม่รู้จัก + ขึ้นเตือน" ซึ่งผู้ใช้เห็นชัดว่าขาด ดีกว่าเลขผิดที่ดูเหมือนถูก.
 */

const OK = {
  is_food: true,
  canonical_name: "ก๋วยจั๊บน้ำข้น",
  basis: "per_serving",
  unit_label: "ชาม",
  unit_grams: 400,
  carb_g: 50,
  protein_g: 20,
  fat_g: 20,
  confidence: 0.8,
};

describe("validateEstimate — เคสที่ควรผ่าน", () => {
  it("ผลลัพธ์ปกติจากเมนูจานเดียว", () => {
    expect(validateEstimate(OK)).toEqual({
      name: "ก๋วยจั๊บน้ำข้น",
      basis: "per_serving",
      unitLabel: "ชาม",
      unitGrams: 400,
      carbG: 50,
      proteinG: 20,
      fatG: 20,
      confidence: 0.8,
    });
  });

  it("วัตถุดิบแบบ per_100g", () => {
    const r = validateEstimate({ ...OK, basis: "per_100g", canonical_name: "เนื้อแกะ", unit_label: "ชิ้น", unit_grams: 120, carb_g: 0, protein_g: 25, fat_g: 21 });
    expect(r).toMatchObject({ basis: "per_100g", proteinG: 25, fatG: 21 });
  });

  it("ปัดมาโครเหลือ 1 ตำแหน่ง", () => {
    expect(validateEstimate({ ...OK, carb_g: 50.26, protein_g: 20.04, fat_g: 19.99 })).toMatchObject({
      carbG: 50.3, proteinG: 20, fatG: 20,
    });
  });

  it("per_serving ที่โมเดลไม่ให้หน่วยมา → เติม 'ที่' ให้ (ไม่งั้นคูณจำนวนไม่ได้)", () => {
    expect(validateEstimate({ ...OK, unit_label: "" })).toMatchObject({ unitLabel: "ที่" });
  });

  it("หน่วยที่โมเดลตอบเป็น g/กรัม ถือว่าไม่ใช่หน่วยนับ → ไม่เอามาใช้", () => {
    expect(validateEstimate({ ...OK, unit_label: "g" })).toMatchObject({ unitLabel: "ที่" });
    expect(validateEstimate({ ...OK, unit_label: "กรัม" })).toMatchObject({ unitLabel: "ที่" });
  });

  it("น้ำหนักต่อหน่วยหลุดช่วง → ตัดทิ้งเฉพาะช่องนั้น ไม่ทิ้งทั้งก้อน", () => {
    expect(validateEstimate({ ...OK, unit_grams: 99999 })).toMatchObject({ unitGrams: null, carbG: 50 });
  });
});

describe("validateEstimate — เคสที่ต้องปฏิเสธ", () => {
  const reject = (patch: Record<string, unknown>, why: string) => {
    it(why, () => expect(validateEstimate({ ...OK, ...patch })).toBeNull());
  };

  reject({ is_food: false }, "ไม่ใช่อาหาร (เช่นพิมพ์ 'รถยนต์')");
  reject({ confidence: 0.4 }, "โมเดลไม่มั่นใจ (< 0.5)");
  reject({ confidence: 1.5 }, "ความมั่นใจเกิน 1 = ค่าเพี้ยน");
  reject({ canonical_name: "" }, "ไม่มีชื่อ");
  reject({ canonical_name: "ก".repeat(61) }, "ชื่อยาวผิดปกติ");
  reject({ basis: "per_kilo" }, "basis นอกเหนือจากที่รองรับ");
  reject({ carb_g: -1 }, "มาโครติดลบ");
  reject({ carb_g: 400 }, "มาโครเกินเพดานต่อหนึ่งหน่วยเสิร์ฟ");
  reject({ basis: "per_100g", carb_g: 60, protein_g: 30, fat_g: 30 }, "per_100g แต่มาโครรวมเกิน 100 กรัม = เป็นไปไม่ได้เชิงฟิสิกส์");
  reject({ carb_g: 0, protein_g: 0, fat_g: 0 }, "ไม่มีสารอาหารเลย = โมเดลไม่รู้จริง");
  reject({ carb_g: 0.5, protein_g: 0, fat_g: 0 }, "พลังงานน้อยผิดปกติ (< 5 kcal)");
  reject({ carb_g: 290, protein_g: 290, fat_g: 290 }, "พลังงานสูงเกินจริง");
  reject({ carb_g: "อร่อย" }, "มาโครไม่ใช่ตัวเลข");
  reject({ confidence: null }, "ไม่มีค่าความมั่นใจ");

  it("ค่าที่ไม่ใช่อ็อบเจกต์", () => {
    expect(validateEstimate(null)).toBeNull();
    expect(validateEstimate("nope")).toBeNull();
    expect(validateEstimate(undefined)).toBeNull();
    expect(validateEstimate({})).toBeNull();
  });
});

describe("validateEstimate — ความสอดคล้องกับกฎ Atwater ของโมดูล", () => {
  it("ค่าที่ผ่านด่านต้องคำนวณ kcal ได้ในช่วงที่สมเหตุสมผลเสมอ", () => {
    const r = validateEstimate(OK)!;
    const kcal = r.carbG * 4 + r.proteinG * 4 + r.fatG * 9;
    expect(kcal).toBeGreaterThanOrEqual(5);
    expect(kcal).toBeLessThanOrEqual(3000);
  });
});
