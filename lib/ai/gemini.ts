/**
 * Gemini client — จุดเดียวในระบบที่คุยกับ LLM ภายนอก (UP Line ที่เหลือเป็น self-host ล้วน).
 *
 * ออกแบบให้ "ล้มแล้วไม่ทำใครเจ็บ": ทุกฟังก์ชันในไฟล์นี้ **ไม่ throw** — คืน null เมื่อมีปัญหา
 * (ไม่มีคีย์ · เน็ตล่ม · เกินโควตา · ตอบไม่เป็น JSON · ช้าเกินงบเวลา) เพราะมันถูกเรียกจาก
 * เส้นทางตอบแชท: ถ้า AI ล่ม บอทต้องยังตอบการ์ดปกติได้ ไม่ใช่เงียบหายทั้งข้อความ.
 *
 * ทำไมยิง REST ตรง ไม่ลงไลบรารี @google/generative-ai:
 *   • ใช้แค่ endpoint เดียว (generateContent) — ไลบรารีเพิ่มขนาด bundle ของ serverless function
 *     โดยไม่ได้อะไรกลับมา
 *   • คุม timeout เองได้ด้วย AbortController ซึ่งจำเป็นมากตรงนี้ (ดู GEMINI_TIMEOUT_MS)
 *
 * ⚠️ ค่าใช้จ่าย: นี่เป็นจุดแรกของ UP Line ที่มี cost ต่อการเรียก — ผู้เรียกต้องมีมาตรการคุม
 * จำนวนครั้งเอง (ดู ai-food.ts: จำกัดจำนวนต่อข้อความ + แคชลงฐานอาหารเพื่อไม่ถามซ้ำ).
 */

/** โมเดลเริ่มต้น — เร็วพอสำหรับตอบแชท และแม่นพอกับงานประเมินค่าอาหาร */
const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * งบเวลาต่อ 1 คำขอ. วัดจริงกับโจทย์อาหารไทย: 2–10 วินาที (median ~4s)
 * — ตั้ง 9s เพื่อให้ยังพอเหลือเวลาให้ webhook ตอบ LINE ทันภายใน maxDuration
 */
const GEMINI_TIMEOUT_MS = 9_000;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** อ่านคีย์จาก env — รองรับหลายชื่อที่นิยมใช้กัน (ตั้งชื่อไหนใน Vercel ก็ติด) */
export function geminiApiKey(): string | null {
  const key =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";
  return key.trim() ? key.trim() : null;
}

/** เปิดใช้ AI ได้ไหม (มีคีย์หรือเปล่า) — ให้ผู้เรียกเช็คก่อนเพื่อข้ามงานที่ไม่จำเป็น */
export function isGeminiEnabled(): boolean {
  return geminiApiKey() !== null;
}

export function geminiModel(): string {
  return (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

export interface GeminiJsonRequest {
  /** คำสั่งระบบ (บทบาท + กติกา) */
  system: string;
  /** โจทย์จริง */
  prompt: string;
  /** JSON Schema แบบ Gemini (type เป็นตัวใหญ่: OBJECT/STRING/NUMBER/BOOLEAN) */
  schema: Record<string, unknown>;
  /** ค่าเริ่มต้น 0 — งานนี้ต้องการความคงเส้นคงวา ไม่ใช่ความสร้างสรรค์ */
  temperature?: number;
  timeoutMs?: number;
}

/**
 * เรียก Gemini แบบบังคับให้ตอบเป็น JSON ตาม schema แล้ว parse ให้เลย.
 * คืน null ทุกกรณีที่ไม่สำเร็จ (พร้อม console.warn ไว้ให้ไล่ดูใน Vercel logs).
 */
export async function generateJson<T>(req: GeminiJsonRequest): Promise<T | null> {
  const key = geminiApiKey();
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(`${ENDPOINT}/${geminiModel()}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature ?? 0,
          responseMimeType: "application/json",
          responseSchema: req.schema,
        },
      }),
    });

    if (!res.ok) {
      // 429 = เกินโควตา/ไม่มีสิทธิ์ free tier · 404 = ชื่อโมเดลใช้ไม่ได้กับคีย์นี้
      const body = await res.text().catch(() => "");
      console.warn(`[gemini] HTTP ${res.status} ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn("[gemini] empty candidate");
      return null;
    }

    return JSON.parse(text) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError = ช้าเกินงบเวลา — ปกติดี ไม่ใช่บั๊ก
    console.warn(`[gemini] request failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
