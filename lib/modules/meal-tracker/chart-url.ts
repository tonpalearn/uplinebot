// ───────────────────────────────────────────────────────────────────────────
// chart-url.ts — สัญญาระหว่าง "การ์ด Flex" กับ "เอนด์พอยต์รูปกราฟ" (PURE, ไม่แตะ DB/network)
// แยกไฟล์ไว้เพราะไฟล์ app/api/**/route.ts ของ Next.js ส่งออกได้เฉพาะ HTTP handler เท่านั้น —
// จะ export ฟังก์ชันช่วยจากที่นั่นไม่ได้ ทั้งฝั่งสร้าง URL และฝั่งอ่าน query จึงต้องมาอยู่ที่นี่
// (ที่เดียว = ไม่มีวันตีความพารามิเตอร์คนละแบบ)
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://uplinebot.vercel.app";

/** ขนาดรูปที่ยอมให้ขอได้ (กันคนยิงขอ 10000px ทำ CPU เซิร์ฟเวอร์พัง) */
const MIN_SIZE = 64;
const MAX_SIZE = 720;
const DEFAULT_SIZE = 420;

/** เพดานกรัมต่อสารอาหารหนึ่งตัว — สูงเกินความเป็นจริงของ "หนึ่งวัน" ไปมากแล้ว */
const MAX_GRAMS = 100000;

export interface MacroParams {
  carbG: number;
  proteinG: number;
  fatG: number;
  size: number;
}

/** Base URL ของแอป (ตัด / ท้ายออก) — ต้องเป็น https สาธารณะ เพราะ LINE เป็นคนมาโหลดรูป */
export function chartBaseUrl(): string {
  const raw = process.env.APP_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** ปัดทศนิยม 1 ตำแหน่ง แล้วตัด ".0" ทิ้ง เพื่อให้ URL สั้นและ "ค่าชุดเดิม = URL เดิม" (แคชได้) */
function compact(n: number): string {
  const v = Math.round(Math.max(0, n) * 10) / 10;
  return String(v);
}

/** URL รูปโดนัทสำหรับมาโครชุดหนึ่ง (หน่วยเป็นกรัม) */
export function macroChartUrl(carbG: number, proteinG: number, fatG: number, size?: number): string {
  const q = new URLSearchParams({
    c: compact(carbG),
    p: compact(proteinG),
    f: compact(fatG),
  });
  if (size && size !== DEFAULT_SIZE) q.set("s", String(Math.round(size)));
  return `${chartBaseUrl()}/api/chart/macro?${q.toString()}`;
}

/** อ่าน+ตรวจ query ของเอนด์พอยต์รูป — คืน null ถ้าพารามิเตอร์ใช้ไม่ได้ (จะตอบ 400) */
export function parseMacroParams(sp: URLSearchParams): MacroParams | null {
  const read = (key: string): number | null => {
    const raw = sp.get(key);
    if (raw === null || raw.trim() === "") return 0; // ไม่ส่งมา = 0 กรัม
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > MAX_GRAMS) return null;
    return v;
  };

  const carbG = read("c");
  const proteinG = read("p");
  const fatG = read("f");
  if (carbG === null || proteinG === null || fatG === null) return null;

  const sizeRaw = sp.get("s");
  let size = DEFAULT_SIZE;
  if (sizeRaw !== null && sizeRaw.trim() !== "") {
    const v = Number(sizeRaw);
    if (!Number.isFinite(v)) return null;
    size = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, v)));
  }

  return { carbG, proteinG, fatG, size };
}
