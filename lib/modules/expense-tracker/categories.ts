// ───────────────────────────────────────────────────────────────────────────
// categories.ts — หมวดหมู่ + เครื่องจัดหมวดแบบ rule-based (pure, เทสต์ได้)
// Ported from EunJod (src/lib/categorize.ts + data/categories.seed.ts), flattened to
// a single-level taxonomy (no sub-categories) per the ledger spec. NO external API / LLM:
// การจัดหมวดทั้งหมดเป็นกฎล้วน — พจนานุกรม exact (หลาย variant) → forward-contains.
// ชั้น "คำที่กลุ่มสอน" (upl_ledger_category_map) ถูกตรวจก่อนใน ledger.ts (ต้องต่อ DB).
// ───────────────────────────────────────────────────────────────────────────

export type LedgerKind = "income" | "expense";

// ── หมวดคงที่ (flat) ──────────────────────────────────────────────────────────
/** หมวดรายจ่ายทั้งหมด (เรียงตามที่แสดง; "อื่นๆ" คือ fallback) */
export const EXPENSE_CATEGORIES = [
  "กิน",
  "เดินทาง",
  "ช้อปปิ้ง",
  "บ้าน/บิล",
  "สุขภาพ",
  "บันเทิง",
  "ครอบครัว",
  "งาน/ธุรกิจ",
  "อื่นๆ",
] as const;

/** หมวดรายรับทั้งหมด ("อื่นๆ" คือ fallback) */
export const INCOME_CATEGORIES = [
  "เงินเดือน",
  "ขาย/รายได้",
  "โบนัส",
  "เงินคืน/ดอกเบี้ย",
  "อื่นๆ",
] as const;

/** อีโมจิประจำหมวด — หนึ่งอีโมจิต่อหนึ่งหมวด (ใช้ในการ์ด/สรุป/หน้าเว็บ) */
export const CATEGORY_EMOJI: Record<string, string> = {
  // expense
  กิน: "🍜",
  เดินทาง: "🚗",
  ช้อปปิ้ง: "🛍️",
  "บ้าน/บิล": "🏠",
  สุขภาพ: "💊",
  บันเทิง: "🎬",
  ครอบครัว: "👨‍👩‍👧",
  "งาน/ธุรกิจ": "💼",
  // income
  เงินเดือน: "💰",
  "ขาย/รายได้": "🛒",
  โบนัส: "🎁",
  "เงินคืน/ดอกเบี้ย": "↩️",
  // shared fallback
  อื่นๆ: "📌",
};

/** อีโมจิของหมวด (default 📌 ถ้าไม่มีในตาราง) */
export function categoryEmoji(category: string): string {
  return CATEGORY_EMOJI[category] ?? "📌";
}

// ── พจนานุกรมคีย์เวิร์ด → หมวด ────────────────────────────────────────────────
// keyword ทุกตัวถูก normalize (lowercase + ตัดช่องว่าง) ตอน build จึงพิมพ์ตามธรรมชาติได้
interface KeywordEntry {
  kind: LedgerKind;
  category: string;
  keywords: string[];
}

const KEYWORDS: KeywordEntry[] = [
  // ── รายจ่าย ────────────────────────────────────────────────────────────────
  {
    kind: "expense",
    category: "กิน",
    keywords: [
      "ข้าว", "ข้าวเช้า", "ข้าวเที่ยง", "ข้าวเย็น", "ข้าวมันไก่", "ข้าวขาหมู", "อาหารตามสั่ง",
      "ก๋วยเตี๋ยว", "ส้มตำ", "หมูกระทะ", "ชาบู", "ปิ้งย่าง", "พิซซ่า", "kfc", "แมค", "mcdonald",
      "ข้าวกล่อง", "อาหาร", "มื้อเที่ยง", "มื้อเย็น", "lineman", "grabfood", "foodpanda", "บุฟเฟ่ต์",
      "กาแฟ", "ลาเต้", "อเมริกาโน่", "คาปูชิโน่", "ชา", "ชาเย็น", "ชานม", "ชาไข่มุก",
      "นม", "น้ำ", "น้ำอัดลม", "โค้ก", "น้ำส้ม", "เบียร์", "เหล้า", "สตาร์บัค", "starbucks",
      "อเมซอน", "โอเลี้ยง", "เครื่องดื่ม", "ขนม", "เค้ก", "โดนัท", "ไอติม", "ไอศกรีม", "ขนมปัง", "เบเกอรี่",
    ],
  },
  {
    kind: "expense",
    category: "เดินทาง",
    keywords: [
      "น้ำมัน", "เติมน้ำมัน", "ปตท", "ptt", "บางจาก", "เชลล์", "shell", "เอสโซ่", "แก๊ส", "lpg",
      "ชาร์จไฟ", "ชาร์จรถ", "ev", "แท็กซี่", "taxi", "grab", "แกร็บ", "bolt", "โบลท์", "วิน",
      "วินมอเตอร์ไซค์", "ตุ๊กตุ๊ก", "bts", "mrt", "รถไฟฟ้า", "รถเมล์", "รถทัวร์", "รถไฟ", "เรือ",
      "ตั๋วรถ", "ตั๋วเครื่องบิน", "เครื่องบิน", "แอร์พอร์ตลิงก์", "ทางด่วน", "ค่าทางด่วน", "มอเตอร์เวย์",
      "easypass", "mflow", "ค่าผ่านทาง", "ที่จอดรถ", "จอดรถ", "ค่าจอด", "parking",
    ],
  },
  {
    kind: "expense",
    category: "ช้อปปิ้ง",
    keywords: [
      "ของใช้", "สบู่", "ยาสีฟัน", "แชมพู", "ทิชชู่", "ผงซักฟอก", "น้ำยา", "ของใช้ในบ้าน",
      "lotus", "โลตัส", "bigc", "บิ๊กซี", "makro", "แม็คโคร", "tops", "7-11", "เซเว่น", "ตลาด",
      "เสื้อ", "กางเกง", "รองเท้า", "เสื้อผ้า", "ชุด", "uniqlo", "กระเป๋า", "เครื่องประดับ", "นาฬิกา",
      "ของฝาก", "ของขวัญ", "gift", "shopee", "ช้อปปี้", "lazada", "ลาซาด้า",
    ],
  },
  {
    kind: "expense",
    category: "บ้าน/บิล",
    keywords: [
      "ค่าน้ำ", "ค่าไฟ", "ค่าน้ำค่าไฟ", "การไฟฟ้า", "การประปา", "บิลไฟ", "บิลน้ำ", "ค่าไฟฟ้า",
      "ค่าน้ำประปา", "ประปา", "เน็ต", "อินเทอร์เน็ต", "wifi", "ไวไฟ", "ค่าโทรศัพท์", "ค่ามือถือ",
      "ais", "true", "ทรู", "dtac", "เติมเงิน", "แพ็กเกจ", "ค่าเช่า", "เช่าบ้าน", "เช่าห้อง",
      "ค่าหอ", "ผ่อนบ้าน", "ส่วนกลาง", "ค่าคอนโด",
    ],
  },
  {
    kind: "expense",
    category: "สุขภาพ",
    keywords: [
      "ยา", "หมอ", "คลินิก", "โรงพยาบาล", "รพ", "ร้านยา", "หาหมอ", "วิตามิน", "อาหารเสริม",
      "ทำฟัน", "หมอฟัน", "ฟิตเนส", "ยิม", "gym", "โยคะ", "วิ่ง", "เวท", "คลาสออกกำลังกาย",
    ],
  },
  {
    kind: "expense",
    category: "บันเทิง",
    keywords: [
      "หนัง", "ดูหนัง", "โรงหนัง", "ตั๋วหนัง", "netflix", "youtube", "spotify", "disney", "viu",
      "hbo", "สตรีมมิง", "เกม", "game", "steam", "เติมเกม", "หนังสือ", "งานอดิเรก", "ของสะสม",
    ],
  },
  {
    kind: "expense",
    category: "ครอบครัว",
    keywords: [
      "ลูก", "นมลูก", "ผ้าอ้อม", "ค่าเทอม", "โรงเรียน", "ของเล่น", "ให้พ่อแม่", "ให้ที่บ้าน",
      "ค่าขนมลูก", "เลี้ยงดู",
    ],
  },
  {
    kind: "expense",
    category: "งาน/ธุรกิจ",
    keywords: [
      "ค่าจ้าง", "ลูกน้อง", "ของออฟฟิศ", "โฆษณา", "ค่าธรรมเนียม", "ต้นทุน", "วัตถุดิบ", "สต๊อก",
      "ค่าส่ง", "ค่าขนส่ง", "ค่าคอมมิชชั่นจ่าย",
    ],
  },

  // ── รายรับ ─────────────────────────────────────────────────────────────────
  { kind: "income", category: "เงินเดือน", keywords: ["เงินเดือน", "salary"] },
  {
    kind: "income",
    category: "ขาย/รายได้",
    keywords: [
      "ขายได้", "ขายของ", "ขาย", "รายได้", "ยอดขาย", "งานเสริม", "ฟรีแลนซ์", "freelance", "ค่าจ้างรับ",
    ],
  },
  { kind: "income", category: "โบนัส", keywords: ["โบนัส", "bonus", "ค่าคอม", "commission", "ทิป", "tip"] },
  {
    kind: "income",
    category: "เงินคืน/ดอกเบี้ย",
    keywords: [
      "เงินคืน", "คืนเงิน", "refund", "ดอกเบี้ย", "เงินปันผล", "ปันผล", "cashback", "แคชแบ็ก",
    ],
  },
];

interface CatKeyword {
  kw: string; // normalized
  kind: LedgerKind;
  category: string;
}

/** พจนานุกรมที่ประมวลผลแล้ว: exact map + รายการเรียงยาว→สั้นสำหรับ forward-contains. */
interface Dictionary {
  exact: Map<string, { kind: LedgerKind; category: string }>;
  entries: CatKeyword[];
}

/** ปรับคำให้เทียบง่าย: ตัวพิมพ์เล็ก + ตัดช่องว่าง (ไม่ตัด "ค่า" ที่นี่ — ทำเป็น variant ตอน match) */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").trim();
}

/** สร้าง variant ของสิ่งที่พิมพ์: คำเต็ม, ตัด "ค่า" นำหน้า, ตัดกริยา จ่าย/ซื้อ/เติม นำหน้า */
function variantsOf(n: string): string[] {
  const out = [n];
  if (n.startsWith("ค่า") && n.length > 3) out.push(n.slice(2));
  const noVerb = n.replace(/^(จ่ายค่า|จ่าย|ซื้อ|เติม)/, "");
  if (noVerb !== n && noVerb.length >= 2) out.push(noVerb);
  return out;
}

// สร้างพจนานุกรมครั้งเดียว (module-level) — keyword ถูก normalize ตอน build.
const DICT: Dictionary = (() => {
  const exact = new Map<string, { kind: LedgerKind; category: string }>();
  const entries: CatKeyword[] = [];
  for (const e of KEYWORDS) {
    for (const kw of e.keywords) {
      const n = normalize(kw);
      if (!n) continue;
      if (!exact.has(n)) exact.set(n, { kind: e.kind, category: e.category });
      entries.push({ kw: n, kind: e.kind, category: e.category });
    }
  }
  // เรียงคำยาว→สั้น เพื่อให้ contains จับคำเฉพาะเจาะจงก่อน (เช่น "ข้าวมันไก่" ก่อน "ข้าว")
  entries.sort((a, b) => b.kw.length - a.kw.length);
  return { exact, entries };
})();

/**
 * จัดหมวดของ `item` ตามชนิด (`kind`) ด้วยกฎล้วน — คืนชื่อหมวด, default "อื่นๆ" ถ้าไม่เจอ.
 * ขั้นตอน: normalize → ลอง variant (คำเต็ม / ตัด "ค่า" / ตัดกริยา) → exact ก่อน แล้ว forward-contains.
 */
export function categorizeLocal(item: string, kind: LedgerKind): string {
  const n = normalize(item);
  if (!n) return "อื่นๆ";
  const variants = variantsOf(n);

  // 1) exact ตาม variant (คำเต็มก่อน แล้วค่อยแบบตัด "ค่า"/กริยา)
  for (const v of variants) {
    const ex = DICT.exact.get(v);
    if (ex && ex.kind === kind) return ex.category;
  }

  // 2) forward-contains — คีย์เวิร์ด (ยาว≥2) เป็นส่วนหนึ่งของสิ่งที่พิมพ์ ("กาแฟเย็น" → "กิน")
  for (const { kw, kind: k, category } of DICT.entries) {
    if (k !== kind) continue;
    if (kw.length >= 2 && variants.some((v) => v.includes(kw))) return category;
  }

  return "อื่นๆ";
}
