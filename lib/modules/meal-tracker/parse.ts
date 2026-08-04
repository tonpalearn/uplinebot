// ───────────────────────────────────────────────────────────────────────────
// parse.ts — แยกข้อความธรรมชาติ → intent ของสมุดอาหาร (บันทึก/สรุป/สอนอาหาร/ดู/ลบ)
// PURE + DETERMINISTIC: ไม่แตะ DB, ไม่เรียก new Date() ข้างใน — ทุกอย่างคำนวณจาก `now` ที่รับเข้า
// (แพตเทิร์นเดียวกับ expense-tracker/parse.ts เพื่อให้เทสต์ล็อกผลได้ 100%).
//
// Timezone: Asia/Bangkok = UTC+7 คงที่ (ไม่มี DST) จึงเลื่อน +7 ชม. เพื่ออ่านวัน/เวลาแบบ wall-clock
// จาก `now` — ไม่พึ่ง timezone ของเซิร์ฟเวอร์ (Vercel รันเป็น UTC).
//
// รูปแบบที่รองรับ:
//   กิน เช้า 3 ส.ค.            ← บรรทัดหัว (มื้อ + วันที่ — ใส่หรือไม่ใส่ก็ได้)
//   ข้าวสวย 100g               ← รายการทีละบรรทัด
//   ไข่ต้ม 2 ฟอง
//   อกไก่ 150g
// หรือบรรทัดเดียว: "กิน เที่ยง ข้าวมันไก่ 1 จาน, ชาเขียวไม่หวาน 1 แก้ว"
// ───────────────────────────────────────────────────────────────────────────

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** ช่วงมื้อ — เก็บใน DB เป็นค่าอังกฤษ (ดู migration 0012 check constraint) */
export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack" | "other";

/** ฐานการคิดของอาหารหนึ่งรายการ (ตรงกับ upl_food_items.basis) */
export type FoodBasis = "per_100g" | "per_serving";

/** หนึ่งบรรทัดรายการอาหารที่แยกออกมาแล้ว (ยังไม่ผูกกับฐานอาหาร) */
export interface ParsedFoodLine {
  name: string; // ชื่ออาหารที่ผู้ใช้พิมพ์ (ตัดจำนวน/หน่วยออกแล้ว)
  qty: number; // จำนวนตามหน่วยที่พิมพ์ (ไม่ระบุ = 1)
  unit: "g" | "unit"; // 'g' = ระบุน้ำหนักมา, 'unit' = นับเป็นหน่วย (ฟอง/ทัพพี/จาน…)
  unitLabel: string | null; // คำหน่วยที่พิมพ์ (ไว้แสดงกลับ เช่น "2 ฟอง")
  raw: string; // บรรทัดเดิม (เก็บลง raw_text)
}

export type MealIntent =
  | {
      action: "record";
      slot: MealSlot;
      slotExplicit: boolean; // false = เดาจากเวลา (ใช้บอกผู้ใช้ว่าเดาให้)
      occurredOn: string; // YYYY-MM-DD (Asia/Bangkok)
      items: ParsedFoodLine[];
    }
  | { action: "day_summary"; occurredOn: string }
  | {
      action: "teach";
      name: string;
      carb: number;
      protein: number;
      fat: number;
      basis: FoodBasis;
      unitLabel: string | null;
      unitGrams: number | null;
    }
  | { action: "lookup"; name: string }
  /** ลบล่าสุด 1 รายการ (ไม่มีอาร์กิวเมนต์) */
  | { action: "undo" }
  /** ลบรายการตามเลขที่เห็นบนการ์ดรายละเอียด เช่น "ลบกิน 3" หรือ "ลบกิน 2,3" */
  | { action: "delete_items"; occurredOn: string; indexes: number[] }
  /** ลบทั้งวัน หรือทั้งมื้อ เช่น "ลบกินทั้งวัน" / "ลบกิน เช้า" */
  | { action: "delete_day"; occurredOn: string; slot: MealSlot | null }
  /** กู้คืนการลบครั้งล่าสุด */
  | { action: "restore" }
  /** รายละเอียดรายมื้อ: กินอะไรไปบ้าง */
  | { action: "day_detail"; occurredOn: string }
  /** ขอลิงก์หน้าเว็บจัดการอาหาร */
  | { action: "link" }
  | { action: "help" }
  | null;

// ── Asia/Bangkok date helpers (fixed UTC+7, no DST) ───────────────────────────
interface BkkYmd {
  y: number;
  m: number; // 1-12
  d: number;
}

function bkkNow(now: Date): Date {
  return new Date(now.getTime() + BKK_OFFSET_MS);
}

function bkkToday(now: Date): BkkYmd {
  const s = bkkNow(now);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** ชั่วโมง 0-23 ตามเวลาไทย — ใช้เดามื้อเมื่อผู้ใช้ไม่ระบุ */
function bkkHour(now: Date): number {
  return bkkNow(now).getUTCHours();
}

function addDays(ymd: BkkYmd, days: number): BkkYmd {
  const base = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

function ymdKey(ymd: BkkYmd): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}

/** ปีพุทธ (>2500) → ค.ศ.; 2 หลัก → 25xx พ.ศ. แล้วแปลง (69 → 2569 → 2026) */
function normalizeYear(y: number): number {
  if (y >= 2500) return y - 543;
  if (y >= 1900) return y;
  if (y < 100) {
    // 2 หลัก: คนไทยพิมพ์ปี พ.ศ. ("69") บ่อยกว่า ค.ศ. ("26") — ตีความเป็น พ.ศ. 25xx
    const buddhist = 2500 + y;
    return buddhist - 543;
  }
  return y;
}

// ชื่อเดือน ไทย (เต็ม + ย่อ) และอังกฤษ (เต็ม + ย่อ) → เลขเดือน
const MONTHS: Array<[RegExp, number]> = [
  [/(?:มกราคม|ม\.?ค\.?|january|jan)/i, 1],
  [/(?:กุมภาพันธ์|ก\.?พ\.?|february|feb)/i, 2],
  [/(?:มีนาคม|มี\.?ค\.?|march|mar)/i, 3],
  [/(?:เมษายน|เม\.?ย\.?|april|apr)/i, 4],
  [/(?:พฤษภาคม|พ\.?ค\.?|may)/i, 5],
  [/(?:มิถุนายน|มิ\.?ย\.?|june|jun)/i, 6],
  [/(?:กรกฎาคม|ก\.?ค\.?|july|jul)/i, 7],
  [/(?:สิงหาคม|ส\.?ค\.?|august|aug)/i, 8],
  [/(?:กันยายน|ก\.?ย\.?|september|sept|sep)/i, 9],
  [/(?:ตุลาคม|ต\.?ค\.?|october|oct)/i, 10],
  [/(?:พฤศจิกายน|พ\.?ย\.?|november|nov)/i, 11],
  [/(?:ธันวาคม|ธ\.?ค\.?|december|dec)/i, 12],
];

/**
 * คำบอกวันแบบสัมพัทธ์ → จำนวนวันจากวันนี้.
 * ต้องมีทั้งฝั่งอดีตและ **อนาคต** — ผู้ใช้บันทึกล่วงหน้าได้ ("กิน เช้า พรุ่งนี้") และถ้าไม่รู้จัก
 * คำนั้น มันจะไม่ถูกตัดออกจากบรรทัดหัว แล้วไหลไปเป็น "รายการอาหารชื่อพรุ่งนี้" (มาโคร 0)
 * ซึ่งเป็นบั๊กแบบเดียวกับที่เคยเจอกับคำว่า "เช้า".
 *
 * ลำดับสำคัญ: ตัวที่ยาว/เจาะจงกว่าต้องมาก่อน (มะรืน ก่อน พรุ่งนี้, วานซืน ก่อน เมื่อวาน)
 */
const REL_WORDS: Array<[RegExp, number]> = [
  [/(?:เมื่อ)?วานซืน/, -2],
  [/เมื่อวาน(?:นี้)?|วานนี้/, -1],
  [/วันนี้/, 0],
  [/มะรืน(?:นี้)?|วันมะรืน/, 2],
  [/พรุ่งนี้|พรุ้งนี้|วันพรุ่งนี้/, 1],
];

/**
 * ดึงวันที่ออกจากข้อความ + คืนข้อความที่ตัดส่วนวันที่ออกแล้ว.
 * รองรับ: "วันนี้/เมื่อวาน/วานซืน", "N วันก่อน", "3 ส.ค.", "3 Aug", "3 สิงหาคม 69", "3/8", "3/8/69"
 * คำว่า "วันที่" ถูกตัดทิ้งก่อนเสมอ (ผู้ใช้พิมพ์ "วันที่ 3 Aug" ได้).
 */
export function extractDate(s: string, today: BkkYmd): { ymd: BkkYmd; rest: string; explicit: boolean } {
  let work = s.replace(/วันที่/g, " ");

  let m = work.match(/(\d+)\s*วัน(?:ก่อน|ที่แล้ว)/);
  if (m) return { ymd: addDays(today, -parseInt(m[1], 10)), rest: work.replace(m[0], " "), explicit: true };

  // ฝั่งอนาคต: "อีก 3 วัน" · "3 วันหน้า" · "3 วันข้างหน้า"
  m = work.match(/อีก\s*(\d+)\s*วัน|(\d+)\s*วัน(?:ข้าง)?หน้า/);
  if (m) {
    const n = parseInt(m[1] ?? m[2], 10);
    return { ymd: addDays(today, n), rest: work.replace(m[0], " "), explicit: true };
  }

  for (const [re, days] of REL_WORDS) {
    const mm = work.match(re);
    if (mm) return { ymd: addDays(today, days), rest: work.replace(mm[0], " "), explicit: true };
  }

  // "<วัน> <ชื่อเดือน> [ปี]" — เช่น 3 ส.ค. / 3 Aug 69 / 3 สิงหาคม 2569
  for (const [re, mo] of MONTHS) {
    const monthRe = new RegExp(`(\\d{1,2})\\s*${re.source}\\.?\\s*(\\d{2,4})?`, "i");
    const mm = work.match(monthRe);
    if (mm) {
      const d = parseInt(mm[1], 10);
      if (d >= 1 && d <= 31) {
        const y = mm[2] ? normalizeYear(parseInt(mm[2], 10)) : today.y;
        return { ymd: { y, m: mo, d }, rest: work.replace(mm[0], " "), explicit: true };
      }
    }
  }

  // d/m หรือ d/m/yy(yy)
  m = work.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const d = +m[1];
    const mo = +m[2];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const y = m[3] ? normalizeYear(+m[3]) : today.y;
      return { ymd: { y, m: mo, d }, rest: work.replace(m[0], " "), explicit: true };
    }
  }

  return { ymd: today, rest: work, explicit: false };
}

// ── มื้ออาหาร ─────────────────────────────────────────────────────────────────
const SLOT_WORDS: Array<[RegExp, MealSlot]> = [
  [/(?:มื้อ)?(?:อาหาร)?เช้า|breakfast/i, "breakfast"],
  [/(?:มื้อ)?(?:อาหาร)?(?:กลางวัน|เที่ยง)|lunch/i, "lunch"],
  [/(?:มื้อ)?(?:อาหาร)?(?:เย็น|ค่ำ)|dinner|supper/i, "dinner"],
  [/(?:มื้อ)?(?:ของ)?ว่าง|snack/i, "snack"],
];

/** ป้ายภาษาไทยของมื้อ (ใช้บนการ์ด) */
export const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "มื้อเช้า",
  lunch: "มื้อกลางวัน",
  dinner: "มื้อเย็น",
  snack: "มื้อว่าง",
  other: "มื้ออื่น ๆ",
};

export const SLOT_EMOJI: Record<MealSlot, string> = {
  breakfast: "🌅",
  lunch: "☀️",
  dinner: "🌙",
  snack: "🍪",
  other: "🍽️",
};

/** ลำดับที่ใช้เรียงมื้อบนการ์ดสรุปทั้งวัน */
export const SLOT_ORDER: MealSlot[] = ["breakfast", "lunch", "dinner", "snack", "other"];

/** เดามื้อจากเวลาไทย เมื่อผู้ใช้ไม่ได้ระบุ (04:00–10:29 เช้า · 10:30–14:59 กลางวัน · 15:00–21:29 เย็น · อื่น ๆ ว่าง) */
export function inferSlot(now: Date): MealSlot {
  const h = bkkHour(now);
  const min = bkkNow(now).getUTCMinutes();
  const t = h * 60 + min;
  if (t >= 4 * 60 && t < 10 * 60 + 30) return "breakfast";
  if (t >= 10 * 60 + 30 && t < 15 * 60) return "lunch";
  if (t >= 15 * 60 && t < 21 * 60 + 30) return "dinner";
  return "snack";
}

/** ดึงคำบอกมื้อออกจากข้อความ + คืนข้อความที่ตัดออกแล้ว */
function extractSlot(s: string): { slot: MealSlot | null; rest: string } {
  for (const [re, slot] of SLOT_WORDS) {
    const m = s.match(re);
    if (m) return { slot, rest: s.replace(m[0], " ") };
  }
  return { slot: null, rest: s };
}

// ── หน่วย/ปริมาณ ──────────────────────────────────────────────────────────────
/**
 * ขอบท้ายหน่วยที่ปลอดภัยกับภาษาไทย.
 * ⚠️ ห้ามใช้ \b กับคำไทย — \b ของ JavaScript นิยามบน [A-Za-z0-9_] เท่านั้น คำที่เป็นอักษรไทยล้วน
 * อย่าง "กรัม" จึงไม่มีขอบให้จับ ทำให้ /^กรัม\b/ ไม่แมตช์เลย (บั๊กจริงที่เทสต์จับได้: พิมพ์
 * "อกไก่ 150 กรัม" แล้วกลายเป็น 1 หน่วยเสิร์ฟ แทนที่จะเป็น 150 กรัม). ใช้ lookahead
 * "ตัวถัดไปต้องไม่ใช่อักษรไทยหรืออังกฤษ" แทน — กัน "ขีดข่วน" ไม่ให้ถูกอ่านเป็นหน่วย "ขีด" ด้วย.
 */
const UNIT_END = "(?![ก-๙a-zA-Z])";

/** หน่วยน้ำหนัก/ปริมาตร → ตัวคูณเป็น "กรัม" (ของเหลวคิด 1 มล. ≈ 1 ก. ซึ่งพอสำหรับงานนี้) */
const WEIGHT_UNITS: Array<[RegExp, number]> = [
  [new RegExp(`^(?:กิโลกรัม|กิโล|กก\\.?|kgs?|kg)${UNIT_END}`, "i"), 1000],
  [new RegExp(`^(?:ลิตร|liters?|litres?|l)${UNIT_END}`, "i"), 1000],
  [new RegExp(`^ขีด${UNIT_END}`), 100],
  [new RegExp(`^(?:กรัม|กรัมส์|grams?|gm|gr|g)\\.?${UNIT_END}`, "i"), 1],
  [new RegExp(`^(?:มิลลิลิตร|มล\\.?|ซีซี|cc|ml)\\.?${UNIT_END}`, "i"), 1],
];

/**
 * คำหน่วยแบบ "นับชิ้น" — จำนวนคูณตรง ๆ กับหน่วยเสิร์ฟของอาหารนั้น.
 * ⚠️ ต้องครอบคลุมทุกค่าที่ใช้เป็น unit_label ในฐานอาหาร (migration 0013) ไม่งั้นผู้ใช้พิมพ์
 * หน่วยที่ระบบเองใช้อยู่ (เช่น "กล้วย 2 ผล") แล้วแยกจำนวนไม่ออก.
 * เรียงให้คำยาวมาก่อนคำสั้นที่เป็นคำนำหน้ากัน ("ช้อนโต๊ะ" ก่อน "ช้อน") เพราะ regex alternation
 * เลือกตัวแรกที่แมตช์.
 */
const COUNT_UNITS = [
  "ฟอง", "ลูก", "ใบ", "ชิ้น", "แผ่น", "ทัพพี", "จาน", "ชาม", "ถ้วย", "แก้ว",
  "กระป๋อง", "ขวด", "กล่อง", "ถุง", "ซอง", "ห่อ", "ไม้", "ที่", "คู่", "เม็ด",
  "ก้อน", "สกู๊ป", "ช้อนโต๊ะ", "ช้อนชา", "ช้อน", "จับ", "ฝัก", "หัว", "ตัว",
  "ดอก", "แท่ง", "ชุด", "มัด", "อัน", "ขด", "แว่น", "กำ", "ผล", "ท่อน", "ซีก",
];

/** ตัวคั่นทางเลือกของหน่วยนับ ใช้ประกอบ regex */
const COUNT_UNIT_RE = COUNT_UNITS.join("|");

/** คำบอกเศษส่วนแบบไทย → ตัวเลข (จับได้ทุกตำแหน่งในบรรทัด ไม่ใช่แค่ต้นบรรทัด) */
const FRACTION_RE = new RegExp(`(ครึ่ง|หนึ่งในสี่|เศษหนึ่งส่วนสี่)\\s*(${COUNT_UNIT_RE})?`);

/**
 * แยกจำนวน+หน่วยออกจากบรรทัดอาหารหนึ่งบรรทัด.
 * กลยุทธ์: หา "จำนวน + หน่วย(ถ้ามี)" ตัวสุดท้ายในบรรทัด แล้วที่เหลือคือชื่ออาหาร —
 * ครอบคลุมทั้ง "ข้าวสวย 100g", "ไข่ต้ม 2 ฟอง", "อกไก่ 150 กรัม" และ "ข้าวสวย ครึ่งทัพพี".
 * ไม่พบตัวเลข → qty 1 unit (นับเป็นหนึ่งหน่วยเสิร์ฟ).
 */
export function parseFoodLine(line: string): ParsedFoodLine | null {
  const raw = line.trim();
  if (!raw) return null;

  // ตัดคำเชื่อมที่คนพิมพ์ติดมา (bullet/ขีดนำหน้า)
  let work = raw.replace(/^[-•·*+]\s*/, "").trim();
  if (!work) return null;

  // 1) คำบอกเศษส่วน ("ส้มตำ ครึ่งจาน", "ข้าวครึ่งทัพพี", "ครึ่งจาน ส้มตำ")
  const frac = work.match(FRACTION_RE);
  if (frac && typeof frac.index === "number") {
    const val = frac[1] === "ครึ่ง" ? 0.5 : 0.25;
    const name = (work.slice(0, frac.index) + " " + work.slice(frac.index + frac[0].length))
      .replace(/\s+/g, " ")
      .trim();
    if (name) return { name, qty: val, unit: "unit", unitLabel: frac[2] ?? null, raw };
  }

  // 1b) เศษส่วนแบบขีดทับ ("ข้าวมันไก่ 1/2 จาน") — รับเฉพาะเศษส่วนแท้ (ตัวบน < ตัวล่าง)
  //     เพื่อไม่ให้ไปตีความอย่างอื่นที่มี / ผิด ๆ
  const slash = work.match(new RegExp(`(\\d+)\\s*/\\s*(\\d+)\\s*(${COUNT_UNIT_RE})?`));
  if (slash && typeof slash.index === "number") {
    const num = parseInt(slash[1], 10);
    const den = parseInt(slash[2], 10);
    if (den > 0 && num > 0 && num < den) {
      const name = (work.slice(0, slash.index) + " " + work.slice(slash.index + slash[0].length))
        .replace(/\s+/g, " ")
        .trim();
      if (name) return { name, qty: num / den, unit: "unit", unitLabel: slash[3] ?? null, raw };
    }
  }

  // 2) ตัวเลข (+ หน่วย) — เอาตัวสุดท้ายที่เจอ เพราะคนไทยพิมพ์ชื่อก่อนจำนวน
  const numRe = /(\d+(?:[.,]\d+)?)\s*([^\s\d]*)/g;
  let match: RegExpExecArray | null;
  let chosen: { qty: number; unit: "g" | "unit"; unitLabel: string | null; start: number; end: number } | null = null;
  /**
   * ตัวสำรอง: "ตัวเลข + คำที่ไม่รู้จักว่าเป็นหน่วย" เช่น "ไก่ทอด 1 น่องใหญ่".
   * รายการหน่วยนับของเรามีจำกัด ไม่มีวันครอบคลุมภาษาที่คนพิมพ์จริงได้หมด — เดิมพอจับหน่วยไม่ได้
   * ทั้งบรรทัดจะกลายเป็น "ชื่ออาหาร" (รวมตัวเลข) แล้วจับคู่ฐานไม่ติดตลอดกาล.
   * เก็บไว้ใช้ต่อเมื่อไม่มีตัวเลือกที่ดีกว่า: ถือเลขเป็นจำนวนหน่วยเสิร์ฟ และเก็บคำนั้นเป็นชื่อหน่วย
   * (ไว้แสดงกลับ) — ชื่อที่เหลือจึงเป็น "ไก่ทอด" ซึ่งค้นฐานเจอ
   */
  let loose: { qty: number; unitLabel: string; start: number; end: number } | null = null;

  while ((match = numRe.exec(work)) !== null) {
    const qty = parseFloat(match[1].replace(",", "."));
    if (!Number.isFinite(qty)) continue;
    const tail = match[2] ?? "";

    // หน่วยน้ำหนัก/ปริมาตร → แปลงเป็นกรัม
    let hit: { unit: "g" | "unit"; unitLabel: string | null; consumed: number } | null = null;
    for (const [re, mult] of WEIGHT_UNITS) {
      const um = tail.match(re);
      if (um) {
        hit = { unit: "g", unitLabel: null, consumed: um[0].length };
        chosen = {
          qty: qty * mult,
          unit: "g",
          unitLabel: null,
          start: match.index,
          end: match.index + match[0].length - (tail.length - um[0].length),
        };
        break;
      }
    }
    if (hit) continue;

    // หน่วยนับชิ้น (อาจอยู่ติดเลข "2ฟอง" หรือเว้นวรรค "2 ฟอง")
    // คำขยายขนาดที่คนพิมพ์ติดหน่วยมาโดยไม่เว้นวรรค ("ถ้วยใหญ่", "ชิ้นเล็ก") — ต้องกลืนไปกับหน่วย
    // ไม่งั้นเศษคำจะค้างอยู่ในชื่ออาหาร ("กาแฟ 1 ถ้วยใหญ่" → ชื่อ "กาแฟ ใหญ่") แล้วค้นฐานเพี้ยน.
    // ใช้รายการคำที่กำหนดไว้แน่นอน ไม่กลืนทั้งคำ เพราะข้อความติดกันอย่าง "จานกับไข่" จะโดนกินไปด้วย
    const countRe = new RegExp(`^(${COUNT_UNIT_RE})(?:ใหญ่|เล็ก|กลาง|จิ๋ว|ยักษ์|พิเศษ)?`);
    const cm = tail.match(countRe);
    if (cm) {
      chosen = {
        qty,
        unit: "unit",
        unitLabel: cm[0],
        start: match.index,
        end: match.index + match[0].length - (tail.length - cm[0].length),
      };
      continue;
    }

    // tail เป็นคำไทย/อังกฤษที่เราไม่รู้จักว่าเป็นหน่วย → จำไว้เป็นตัวสำรอง (ดูตัวแปร loose)
    if (qty > 0 && /^[ก-๙a-zA-Z]{1,14}$/.test(tail)) {
      loose = {
        qty,
        unitLabel: tail,
        start: match.index,
        end: match.index + match[0].length,
      };
    }

    // ตัวเลขเปล่า ๆ — อาจตามด้วยหน่วยที่เว้นวรรคไว้ (จับที่ tail ว่างแล้วดูคำถัดไป)
    if (tail === "") {
      const after = work.slice(match.index + match[0].length);
      const nextUnit = after.match(new RegExp(`^\\s*(${COUNT_UNIT_RE})`));
      if (nextUnit) {
        chosen = {
          qty,
          unit: "unit",
          unitLabel: nextUnit[1],
          start: match.index,
          end: match.index + match[0].length + nextUnit[0].length,
        };
        continue;
      }
      const nextWeight = after.trimStart();
      let weightHit = false;
      for (const [re, mult] of WEIGHT_UNITS) {
        const um = nextWeight.match(re);
        if (um) {
          const lead = after.length - nextWeight.length;
          chosen = {
            qty: qty * mult,
            unit: "g",
            unitLabel: null,
            start: match.index,
            end: match.index + match[0].length + lead + um[0].length,
          };
          weightHit = true;
          break;
        }
      }
      if (weightHit) continue;
      // เลขเปล่าไม่มีหน่วย → ถือเป็นจำนวนหน่วยเสิร์ฟ
      chosen = { qty, unit: "unit", unitLabel: null, start: match.index, end: match.index + match[1].length };
    }
  }

  if (!chosen && loose) {
    chosen = { qty: loose.qty, unit: "unit", unitLabel: loose.unitLabel, start: loose.start, end: loose.end };
  }

  if (!chosen) {
    return { name: work, qty: 1, unit: "unit", unitLabel: null, raw };
  }

  let name = (work.slice(0, chosen.start) + " " + work.slice(chosen.end))
    .replace(/\s+/g, " ")
    .replace(/^[xX*×]\s*/, "")
    .trim();

  // เก็บกวาด: ถ้ายังมี "ตัวเลข (+หน่วยนับ)" ค้างอยู่ในชื่อ (เช่น "นมสด 1 กล่อง 250ml" ที่เราหยิบ
  // 250ml ไปเป็นปริมาณ แล้วเหลือ "นมสด 1 กล่อง") ให้ตัดออก — ไม่งั้นชื่อที่เอาไปค้นฐานจะเพี้ยน
  // จนจับคู่ไม่ติด. ใช้ผลลัพธ์ที่กวาดแล้วเฉพาะเมื่อยังเหลือชื่อจริง ๆ อยู่
  const cleaned = name
    .replace(new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:${COUNT_UNIT_RE})?`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) name = cleaned;

  if (!name) return null; // มีแต่ตัวเลข ไม่มีชื่ออาหาร → ข้าม
  return { name, qty: chosen.qty, unit: chosen.unit, unitLabel: chosen.unitLabel, raw };
}

/** แยกข้อความหลายรายการ (ขึ้นบรรทัดใหม่ หรือคั่นด้วย , ;) → ParsedFoodLine[] */
function parseFoodLines(text: string): ParsedFoodLine[] {
  const out: ParsedFoodLine[] = [];
  for (const seg of text.split(/[\n,;]+/)) {
    const item = parseFoodLine(seg);
    if (item) out.push(item);
  }
  return out;
}

// ── คำสั่ง ─────────────────────────────────────────────────────────────────────
/** "กิน …" — ต้องมี "กิน" นำหน้าเสมอ (กันข้อความคุยเล่นในกลุ่มถูกจดเป็นอาหาร) */
const CMD_EAT = /^(?:กิน|ทาน|มื้อ|eat)(?:\s+([\s\S]*))?$/i;
/** สรุปทั้งวัน */
const CMD_DAY = /^(?:สรุปกิน|สรุปอาหาร|กินวันนี้|อาหารวันนี้|สรุปมื้อ|รวมกิน)(?:\s+(.*))?$/i;
/** สอนอาหารใหม่: "สอนอาหาร ข้าวมันไก่ = C78 P28 F22" (รับ C/P/F สลับลำดับได้) */
const CMD_TEACH = /^(?:สอนอาหาร|เพิ่มอาหาร|จำอาหาร)\s+([\s\S]+)$/i;
/** ดูค่าอาหารหนึ่งอย่าง */
const CMD_LOOKUP = /^(?:อาหาร|ดูอาหาร|ค่าอาหาร|แคล|kcal)\s+(.+)$/i;
/** ลบรายการล่าสุด (ไม่มีอะไรต่อท้าย) */
const CMD_UNDO = /^(?:ลบกิน|ยกเลิกกิน|ลบอาหาร|undo\s*กิน)$/i;
/** ลบแบบระบุ: "ลบกิน 3" · "ลบกิน 2,3" · "ลบกิน เช้า" · "ลบกินทั้งวัน" · "ลบกินวันนี้" */
const CMD_DELETE = /^(?:ลบกิน|ยกเลิกกิน|ลบอาหาร|ลบมื้อ)\s*(.+)$/i;
/** กู้คืนการลบครั้งล่าสุด */
const CMD_RESTORE = /^(?:กู้กิน|เลิกลบกิน|ยกเลิกลบกิน|คืนกิน|กู้คืนกิน)(?:\s+(.*))?$/i;
/** รายละเอียดรายมื้อ — กินอะไรไปบ้าง (ไม่ใช่แค่ยอดรวม) */
const CMD_DETAIL = /^(?:รายละเอียดกิน|รายการกิน|กินอะไรบ้าง|กินอะไรไปบ้าง|ดูรายการกิน|รายละเอียดมื้อ)(?:\s+(.*))?$/i;
/** "ทั้งวัน"/"วันนี้"/"หมด" ในบริบทคำสั่งลบ = ลบทุกรายการของวันนั้น */
const DELETE_ALL_RE = /^(?:ทั้งวัน|ทั้งหมด|หมด|วันนี้|all)$/i;
/** ขอลิงก์หน้าเว็บจัดการอาหาร/ฐานอาหาร */
const CMD_LINK = /^(?:จัดการอาหาร|แก้กิน|แก้ไขกิน|เว็บกิน|ลิงก์กิน|ลิงค์กิน|ฐานอาหาร|จัดการกิน)$/i;
/** วิธีใช้ */
const CMD_HELP = /^(?:วิธีกิน|ช่วยกิน|help\s*กิน|กินยังไง)$/i;

/**
 * แยกค่ามาโครจากประโยคสอนอาหาร — รับได้ทั้ง
 *   "ข้าวมันไก่ = C78 P28 F22"
 *   "ข้าวมันไก่ = คาร์บ 78 โปรตีน 28 ไขมัน 22 ต่อจาน 350g"
 *   "โปรตีนบาร์ = C 20 P 15 F 8 ต่อชิ้น"
 * คืน null ถ้าอ่านมาโครไม่ครบ (ต้องมีอย่างน้อย 1 ตัว และไม่มีตัวไหนติดลบ).
 */
function parseTeach(body: string): Extract<MealIntent, { action: "teach" }> | null {
  const eq = body.indexOf("=");
  if (eq < 0) return null;
  const name = body.slice(0, eq).trim();
  const spec = body.slice(eq + 1).trim();
  if (!name || !spec) return null;

  const num = (re: RegExp): number | null => {
    const m = spec.match(re);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };

  const carb = num(/(?:คาร์บ|คาโบ|carbs?|c)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  const protein = num(/(?:โปรตีน|protein|p)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  const fat = num(/(?:ไขมัน|fats?|f)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (carb === null && protein === null && fat === null) return null;

  // ฐาน: "ต่อ 100g" = per_100g (ค่าเริ่มต้นสำหรับวัตถุดิบ) · "ต่อจาน/ชิ้น/…" = per_serving
  let basis: FoodBasis = "per_100g";
  let unitLabel: string | null = null;
  let unitGrams: number | null = null;

  const per100 = /ต่อ\s*100\s*(?:g|กรัม)/i.test(spec);
  const perUnit = spec.match(new RegExp(`ต่อ\\s*(${COUNT_UNIT_RE})`));
  if (perUnit) {
    basis = "per_serving";
    unitLabel = perUnit[1];
  } else if (!per100) {
    // ไม่ได้บอกฐาน → เดาว่าเป็น "ต่อหนึ่งหน่วยเสิร์ฟ" เพราะคนสอนมักสอนเป็นเมนู/ชิ้น
    basis = "per_serving";
    unitLabel = "ที่";
  }

  // น้ำหนักต่อหน่วย ถ้าระบุมา เช่น "ต่อจาน 350g"
  const gm = spec.match(/(\d+(?:\.\d+)?)\s*(?:g|กรัม)\b/i);
  if (gm && !per100) {
    const g = parseFloat(gm[1]);
    if (Number.isFinite(g) && g > 0) unitGrams = g;
  }

  return {
    action: "teach",
    name,
    carb: carb ?? 0,
    protein: protein ?? 0,
    fat: fat ?? 0,
    basis,
    unitLabel,
    unitGrams,
  };
}

/**
 * แปลงข้อความ → MealIntent. ข้อความที่ไม่ตรงคำสั่งใด ๆ → null (โมดูลไม่แมตช์ บอทเงียบ)
 * เพื่อไม่ไปกลืนข้อความของโมดูลอื่น (todo/ledger/KM) หรือบทสนทนาปกติในกลุ่ม.
 */
export function parseMealIntent(text: string, now: Date): MealIntent {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const firstLine = trimmed.split("\n")[0].trim();
  const today = bkkToday(now);

  if (CMD_HELP.test(firstLine)) return { action: "help" };
  if (CMD_LINK.test(firstLine)) return { action: "link" };
  // ต้องเช็ค UNDO (ไม่มีอาร์กิวเมนต์) ก่อน DELETE (มีอาร์กิวเมนต์) — สองตัวนี้ใช้คำนำหน้าเดียวกัน
  if (CMD_UNDO.test(firstLine)) return { action: "undo" };

  const restoreMatch = firstLine.match(CMD_RESTORE);
  if (restoreMatch) return { action: "restore" };

  const detailMatch = firstLine.match(CMD_DETAIL);
  if (detailMatch) {
    const { ymd } = extractDate(detailMatch[1] ?? "", today);
    return { action: "day_detail", occurredOn: ymdKey(ymd) };
  }

  const deleteMatch = firstLine.match(CMD_DELETE);
  if (deleteMatch) {
    const arg = deleteMatch[1].trim();

    // วันที่ (ถ้ามี) ถูกดึงออกก่อน เพื่อให้ "ลบกิน เช้า เมื่อวาน" ทำงานได้
    const { ymd, rest } = extractDate(arg, today);
    const occurredOn = ymdKey(ymd);
    const body = rest.trim();

    // "ลบกิน 3" / "ลบกิน 2,3" / "ลบกิน 2 3"
    const nums = body.match(/\d+/g);
    if (nums && /^[\d\s,،และ]+$/.test(body)) {
      const indexes = Array.from(new Set(nums.map(Number).filter((n) => n >= 1)));
      if (indexes.length > 0) return { action: "delete_items", occurredOn, indexes };
    }

    // "ลบกิน เช้า" → ทั้งมื้อ · "ลบกินทั้งวัน" → ทั้งวัน
    const { slot, rest: afterSlot } = extractSlot(body);
    if (slot && afterSlot.trim() === "") return { action: "delete_day", occurredOn, slot };
    if (DELETE_ALL_RE.test(body)) return { action: "delete_day", occurredOn, slot: null };
    if (body === "") return { action: "delete_day", occurredOn, slot: null };

    return { action: "help" };
  }

  const teachMatch = firstLine.match(CMD_TEACH);
  if (teachMatch) return parseTeach(teachMatch[1]) ?? { action: "help" };

  const lookupMatch = firstLine.match(CMD_LOOKUP);
  if (lookupMatch) {
    const name = lookupMatch[1].trim();
    if (name) return { action: "lookup", name };
  }

  const dayMatch = firstLine.match(CMD_DAY);
  if (dayMatch) {
    const { ymd } = extractDate(dayMatch[1] ?? "", today);
    return { action: "day_summary", occurredOn: ymdKey(ymd) };
  }

  const eatMatch = firstLine.match(CMD_EAT);
  if (!eatMatch) return null;

  // บรรทัดแรก: "กิน [มื้อ] [วันที่] [รายการแรก…]"
  const head = (eatMatch[1] ?? "").trim();
  const { slot: slotFromText, rest: afterSlot } = extractSlot(head);
  const { ymd, rest: afterDate } = extractDate(afterSlot, today);

  const inlineItems = afterDate.replace(/\s+/g, " ").trim();
  let bodyLines = trimmed.split("\n").slice(1);

  // ผู้ใช้จำนวนมากพิมพ์ "กิน" แล้วขึ้นบรรทัดใหม่เป็นชื่อมื้อ:
  //     กิน
  //     เช้า
  //     ข้าวสวย 100g
  // เดิมอ่านมื้อจากบรรทัดแรกอย่างเดียว "เช้า" จึงกลายเป็น "อาหารชื่อเช้า" (มาโคร 0) และมื้อถูก
  // เดาจากเวลาแทน — ผิดทั้งคู่. ถ้าบรรทัดแรกไม่ได้ระบุมื้อไว้ และบรรทัดถัดมาเป็น "ชื่อมื้อล้วน ๆ"
  // ให้ถือเป็นมื้อแล้วตัดออกจากรายการอาหาร
  let slot = slotFromText;
  let slotFromOwnLine = false;
  if (!slot && !inlineItems) {
    const idx = bodyLines.findIndex((l) => l.trim() !== "");
    if (idx !== -1) {
      const candidate = bodyLines[idx].trim();
      const probe = extractSlot(candidate);
      // ต้องเป็นชื่อมื้อล้วน ๆ เท่านั้น — "เช้า" ใช่, "ข้าวเช้า 1 จาน" ไม่ใช่ (จะกินรายการอาหารไป)
      if (probe.slot && probe.rest.trim() === "") {
        slot = probe.slot;
        slotFromOwnLine = true;
        bodyLines = bodyLines.filter((_, i) => i !== idx);
      }
    }
  }

  const itemText = [inlineItems, bodyLines.join("\n")].filter((s) => s && s.trim()).join("\n");

  return {
    action: "record",
    slot: slot ?? inferSlot(now),
    slotExplicit: slotFromText !== null || slotFromOwnLine,
    occurredOn: ymdKey(ymd),
    items: parseFoodLines(itemText),
  };
}
