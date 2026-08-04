import { NextResponse } from "next/server";
import { isGeminiEnabled, geminiModel, geminiKeySource } from "@/lib/ai/gemini";

/**
 * Health check — บอกว่า "ตั้งค่าอะไรไว้บ้าง" โดยไม่เปิดเผยค่าลับใด ๆ.
 *
 * มีไว้เพราะบทเรียนตอนต่อ AI mode: คีย์ Gemini ที่ **มีอยู่** กับคีย์ที่ **ใช้ได้จริง** เป็นคนละเรื่อง
 * (คีย์หนึ่งของเราตอบ HTTP 429 `limit: 0` = ไม่มีสิทธิ์ free tier เลย ทั้งที่คีย์ถูกต้องทุกตัวอักษร)
 * และ env var ที่เพิ่งใส่ใน Vercel จะยังไม่มีผลจนกว่าจะ redeploy — สองอย่างนี้มองจากข้างนอกไม่เห็น
 * เลยถ้าไม่มีปลายทางให้ถาม.
 *
 * ตอบเฉพาะ boolean + ชื่อโมเดล (ซึ่งอยู่ในเอกสารสาธารณะอยู่แล้ว) — ไม่มีคีย์ ไม่มี URL ฐานข้อมูล
 * ไม่มีข้อมูลลูกค้า. ไม่ยิง Gemini จริงเพื่อไม่ให้ใครใช้ปลายทางนี้ผลาญโควตาของเรา — การพิสูจน์ว่า
 * "คีย์ใช้ได้จริง" ทำโดยพิมพ์อาหารนอกฐานในไลน์แล้วดูว่ามีแถว source='ai-estimate' เกิดขึ้นไหม.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    ai: {
      /** true = มี GEMINI_API_KEY ใน env ของ deployment นี้ (ยังไม่ได้แปลว่าโควตายังเหลือ) */
      configured: isGeminiEnabled(),
      /** ชื่อ env ที่เจอคีย์ (ไม่ใช่ค่า) — null = ยังไม่เจอชื่อไหนเลย ดู KEY_ENV_NAMES ว่ารับชื่ออะไรบ้าง */
      keySource: geminiKeySource(),
      model: geminiModel(),
      /**
       * ชื่อ env ที่ตั้งไว้จริงใน deployment นี้ซึ่งเกี่ยวกับ Gemini/Google — **ชื่ออย่างเดียว ไม่มีค่า**
       * ไว้ตอบคำถามเดียว: "ใส่คีย์ไปแล้วแต่ระบบไม่เห็น เพราะตั้งชื่อผิดหรือใส่ผิดที่?"
       * กรองแคบ ๆ แค่ 2 คำนี้ เพื่อไม่ให้เผยผังคอนฟิกส่วนอื่นของระบบ
       */
      googleEnvNames: Object.keys(process.env).filter((k) => /gemini|google/i.test(k)).sort(),
    },
    ts: new Date().toISOString(),
  });
}
