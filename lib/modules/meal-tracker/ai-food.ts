import { generateJson, isGeminiEnabled } from "../../ai/gemini";
import type { FoodBasis } from "./parse";

/**
 * AI mode — เมื่อจับคู่อาหารกับฐานไม่ได้ ให้ AI ประเมินค่าสารอาหารให้ แล้วเก็บเข้าฐานของ tenant
 * (ผู้เรียกเป็นคนเก็บ — ไฟล์นี้แค่ "ประเมิน + ตรวจ" ไม่แตะ DB).
 *
 * ⚠️ นี่คือตัวเลขที่จะไปโผล่บนการ์ดโค้ชชิ่ง — จึงมี 2 ด่านคุมคุณภาพ:
 *   ด่าน 1 (ที่โมเดล) : บังคับตอบ JSON ตาม schema + ให้ตอบ is_food=false ถ้าไม่ใช่อาหาร
 *   ด่าน 2 (ที่เรา)   : validateEstimate() ตรวจช่วงค่าที่ "เป็นไปได้จริง" ทุกตัว — ค่าที่หลุดช่วง
 *                       ถูกทิ้งทั้งก้อน แล้วตกกลับไปเส้นทางเดิม (ขึ้นเตือน "ยังไม่รู้จัก")
 *
 * หลักที่ไม่ยอมถอย: **ถ้าไม่มั่นใจ ให้ "ไม่มีตัวเลข" ดีกว่า "ตัวเลขมั่ว"** — เพราะบนการ์ด
 * ผู้ใช้แยกไม่ออกว่าเลขไหนน่าเชื่อ ตัวเลขที่ผิดจึงอันตรายกว่าช่องว่างที่เห็นชัด.
 *
 * ค่าที่ได้จะถูกบันทึกด้วย `source='ai-estimate'` เสมอ — แยกจาก 'seed-approx' (ฐานกลาง)
 * และ 'chat' (คนสอนเอง) เพื่อให้ตามรอยได้ว่าเลขไหนมาจากไหน และการ์ดเอาไปติดป้าย 🤖 ได้.
 */

export interface AiFoodEstimate {
  name: string;
  basis: FoodBasis;
  unitLabel: string | null;
  unitGrams: number | null;
  carbG: number;
  proteinG: number;
  fatG: number;
  confidence: number;
}

/** รูปดิบที่โมเดลตอบกลับมา (ยังไม่ผ่านการตรวจ) */
interface RawEstimate {
  is_food: boolean;
  canonical_name: string;
  basis: string;
  unit_label: string;
  unit_grams: number;
  carb_g: number;
  protein_g: number;
  fat_g: number;
  confidence: number;
}

const SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    is_food: { type: "BOOLEAN" },
    canonical_name: { type: "STRING" },
    basis: { type: "STRING", enum: ["per_100g", "per_serving"] },
    unit_label: { type: "STRING" },
    unit_grams: { type: "NUMBER" },
    carb_g: { type: "NUMBER" },
    protein_g: { type: "NUMBER" },
    fat_g: { type: "NUMBER" },
    confidence: { type: "NUMBER" },
  },
  required: [
    "is_food", "canonical_name", "basis", "unit_label", "unit_grams",
    "carb_g", "protein_g", "fat_g", "confidence",
  ],
};

const SYSTEM = [
  "คุณคือนักโภชนาการที่ประเมินค่าสารอาหารของอาหารและเครื่องดื่ม โดยเน้นอาหารไทยและอาหารที่หากินได้ในไทย",
  "ตอบเป็น JSON ตาม schema เท่านั้น ห้ามมีข้อความอื่น",
  "ใช้ค่ามาตรฐานที่ยอมรับกันทั่วไป (แนวตารางอาหารไทย/USDA) สำหรับ 'หนึ่งหน่วยที่คนไทยกินจริง'",
  // กับดักที่เจอจริง: โมเดลให้คาร์บของ "ข้าวสารดิบ" (79 g ต่อ 100 g) แต่ให้ unit_grams เป็น
  // "ข้าวสุก 1 ถ้วย 185 g" — คูณกันแล้วพลังงานพุ่งเป็น ~3 เท่าของความจริง
  "**สำคัญที่สุด: ให้ค่าของอาหารในสภาพที่กินจริง (ปรุงสุก พร้อมรับประทาน) เสมอ**",
  "ข้าว เส้นก๋วยเตี๋ยว พาสต้า บะหมี่ ถั่วเมล็ดแห้ง ข้าวโอ๊ต ให้ใช้ค่าของ 'ที่หุง/ต้มสุกแล้ว' ห้ามใช้ค่าของเมล็ด/เส้นดิบเด็ดขาด",
  "ตรวจความสมเหตุสมผลก่อนตอบ: อาหารพร้อมกินส่วนใหญ่มีพลังงาน 80–250 kcal ต่อ 100 กรัม (ข้าวสวยสุก ≈ 130, เส้นสุก ≈ 110–160) ถ้าค่าที่คิดได้สูงกว่านี้มากโดยไม่ใช่ของทอด/มัน/ของแห้ง แปลว่ากำลังใช้ค่าของวัตถุดิบดิบ ให้แก้เป็นค่าสุก",
  "ถ้าเป็นเมนูจานเดียว/เครื่องดื่ม ให้ basis=per_serving แล้วระบุ unit_label (จาน/ชาม/แก้ว/ชิ้น/ถ้วย) กับ unit_grams ของหนึ่งหน่วยนั้น",
  "ถ้าเป็นวัตถุดิบดิบ ๆ (เนื้อสัตว์ ผัก ผลไม้ ธัญพืช) ให้ basis=per_100g แล้ว unit_label เป็นหน่วยนับที่คนใช้ (ชิ้น/ผล/ฟอง) พร้อม unit_grams ต่อหนึ่งหน่วย",
  "ห้ามใส่เครื่องดื่มแอลกอฮอล์ — ถ้าเป็นแอลกอฮอล์ให้ is_food=false",
  "ถ้าข้อความที่ให้มาไม่ใช่ชื่ออาหาร/เครื่องดื่ม หรือกำกวมจนเดาไม่ได้ ให้ is_food=false",
  "confidence = ความมั่นใจ 0–1 ถ้าไม่แน่ใจให้ต่ำกว่า 0.5 อย่าเดาสุ่ม",
].join("\n");

// ── ด่านตรวจค่า ─────────────────────────────────────────────────────────────────
/** ต่ำกว่านี้ถือว่าโมเดลก็ไม่มั่นใจ — ไม่เอาดีกว่า */
const MIN_CONFIDENCE = 0.5;

/** เพดานที่ "เป็นไปได้จริง" ต่อ 100 กรัม — น้ำมันคือ 100g ไขมัน จึงเป็นเพดานธรรมชาติ */
const MAX_PER_100G = 100;
/** เพดานต่อหนึ่งหน่วยเสิร์ฟ — บุฟเฟต์จานยักษ์ก็ไม่ควรเกินนี้ */
const MAX_PER_SERVING = 300;
/** ช่วงน้ำหนักต่อหน่วยที่สมเหตุสมผล (1 เม็ดองุ่น ~5g ถึง หม้อสุกี้ ~2kg) */
const MIN_UNIT_G = 1;
const MAX_UNIT_G = 2000;
/** พลังงานต่อหน่วยที่ยอมรับได้ — กันทั้ง "0 แคล" และ "หมื่นแคลต่อจาน" */
const MIN_KCAL = 5;
const MAX_KCAL = 3000;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * ตรวจผลจากโมเดลให้ครบทุกช่อง — คืน null ถ้ามีอะไรหลุดช่วงแม้แต่ตัวเดียว.
 * export ไว้เพื่อให้เทสต์ยิงเคสพิสดารได้โดยไม่ต้องเรียก API จริง.
 */
export function validateEstimate(raw: unknown): AiFoodEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RawEstimate>;

  if (r.is_food !== true) return null;

  const confidence = num(r.confidence);
  if (confidence === null || confidence < MIN_CONFIDENCE || confidence > 1) return null;

  const name = typeof r.canonical_name === "string" ? r.canonical_name.trim() : "";
  if (!name || name.length > 60) return null;

  const basis: FoodBasis = r.basis === "per_serving" ? "per_serving" : "per_100g";
  if (r.basis !== "per_serving" && r.basis !== "per_100g") return null;

  const carbG = num(r.carb_g);
  const proteinG = num(r.protein_g);
  const fatG = num(r.fat_g);
  if (carbG === null || proteinG === null || fatG === null) return null;
  if (carbG < 0 || proteinG < 0 || fatG < 0) return null;

  const cap = basis === "per_100g" ? MAX_PER_100G : MAX_PER_SERVING;
  if (carbG > cap || proteinG > cap || fatG > cap) return null;
  // per_100g: มาโครรวมกันเกิน 100 กรัมต่อ 100 กรัม = เป็นไปไม่ได้เชิงฟิสิกส์
  if (basis === "per_100g" && carbG + proteinG + fatG > 100) return null;

  // ไม่มีสารอาหารเลย → อาจเป็นน้ำเปล่า/ชาไม่หวาน ซึ่ง "ถูก" แต่ก็ไม่ต้องให้ AI เดาให้
  // (ของพวกนี้อยู่ในฐานกลางแล้ว) — ตรงนี้ถือว่าโมเดลไม่รู้จริง
  if (carbG + proteinG + fatG <= 0) return null;

  const kcal = carbG * 4 + proteinG * 4 + fatG * 9;
  if (kcal < MIN_KCAL || kcal > MAX_KCAL) return null;

  let unitGrams = num(r.unit_grams);
  if (unitGrams !== null && (unitGrams < MIN_UNIT_G || unitGrams > MAX_UNIT_G)) unitGrams = null;

  const unitLabelRaw = typeof r.unit_label === "string" ? r.unit_label.trim() : "";
  // กันโมเดลตอบหน่วยเป็น "g"/"grams" ซึ่งไม่ใช่ "หน่วยนับ" ที่ระบบใช้แปลง
  const unitLabel =
    unitLabelRaw && unitLabelRaw.length <= 12 && !/^(g|gram|grams|กรัม|ml)$/i.test(unitLabelRaw)
      ? unitLabelRaw
      : null;

  // per_serving ที่ไม่รู้หน่วย = ใช้ต่อไม่ได้ (คูณจำนวนไม่ถูก) → ตั้งเป็น "ที่" กลาง ๆ
  return {
    name,
    basis,
    unitLabel: unitLabel ?? (basis === "per_serving" ? "ที่" : null),
    unitGrams,
    carbG: Math.round(carbG * 10) / 10,
    proteinG: Math.round(proteinG * 10) / 10,
    fatG: Math.round(fatG * 10) / 10,
    confidence,
  };
}

/**
 * ถาม AI ว่าอาหารชื่อนี้มีสารอาหารเท่าไร — คืน null ถ้าไม่มีคีย์ / เรียกไม่สำเร็จ / ค่าไม่ผ่านด่านตรวจ.
 * ไม่ throw เด็ดขาด (อยู่บนเส้นทางตอบแชท).
 */
export async function estimateFoodMacros(name: string): Promise<AiFoodEstimate | null> {
  const q = (name ?? "").trim();
  if (!q || q.length > 60 || !isGeminiEnabled()) return null;

  const raw = await generateJson<RawEstimate>({
    system: SYSTEM,
    prompt: `ประเมินค่าสารอาหารของ: "${q}"`,
    schema: SCHEMA,
  });

  return validateEstimate(raw);
}
