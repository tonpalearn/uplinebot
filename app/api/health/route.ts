import { NextResponse } from "next/server";
import { isGeminiEnabled, geminiModel, geminiKeySource } from "@/lib/ai/gemini";
import { readCronHealth } from "@/lib/scheduler/heartbeat";

/**
 * Health check — บอกว่า "ตั้งค่าอะไรไว้บ้าง" โดยไม่เปิดเผยค่าลับใด ๆ.
 *
 * มีไว้เพราะบทเรียนตอนต่อ AI mode: คีย์ Gemini ที่ **มีอยู่** กับคีย์ที่ **ใช้ได้จริง** เป็นคนละเรื่อง
 * (คีย์หนึ่งของเราตอบ HTTP 429 `limit: 0` = ไม่มีสิทธิ์ free tier เลย ทั้งที่คีย์ถูกต้องทุกตัวอักษร)
 * และ env var ที่เพิ่งใส่ใน Vercel จะยังไม่มีผลจนกว่าจะ redeploy — สองอย่างนี้มองจากข้างนอกไม่เห็น
 * เลยถ้าไม่มีปลายทางให้ถาม.
 *
 * รายงาน commit ที่ deploy อยู่ด้วย (`VERCEL_GIT_COMMIT_SHA` ที่ Vercel ใส่ให้เอง) — เจอมาแล้ว 2 ครั้ง
 * ว่า push ขึ้น GitHub ครบแต่ Vercel **ไม่สร้าง build เลย** ทำให้ทดสอบของใหม่แล้วงงว่าทำไมพฤติกรรมเก่า
 * ไม่มีทางรู้จากข้างนอกเลยถ้าไม่มีตรงนี้ (repo เป็น public อยู่แล้ว SHA จึงไม่ใช่ความลับ)
 *
 * ตอบเฉพาะ boolean + ชื่อโมเดล (ซึ่งอยู่ในเอกสารสาธารณะอยู่แล้ว) — ไม่มีคีย์ ไม่มี URL ฐานข้อมูล
 * ไม่มีข้อมูลลูกค้า. ไม่ยิง Gemini จริงเพื่อไม่ให้ใครใช้ปลายทางนี้ผลาญโควตาของเรา — การพิสูจน์ว่า
 * "คีย์ใช้ได้จริง" ทำโดยพิมพ์อาหารนอกฐานในไลน์แล้วดูว่ามีแถว source='ai-estimate' เกิดขึ้นไหม.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // ชีพจร cron — คำถาม "ตั้งเวลาแล้วทำไมไม่มา" ตอบได้ที่นี่ ไม่ต้องไล่โค้ด
  const cron = await readCronHealth();

  return NextResponse.json({
    ok: true,
    cron,
    ai: {
      /** true = มี GEMINI_API_KEY ใน env ของ deployment นี้ (ยังไม่ได้แปลว่าโควตายังเหลือ) */
      configured: isGeminiEnabled(),
      /** ชื่อ env ที่เจอคีย์ (ไม่ใช่ค่า) — null = ยังไม่เจอชื่อไหนเลย ดู KEY_ENV_NAMES ว่ารับชื่ออะไรบ้าง */
      keySource: geminiKeySource(),
      model: geminiModel(),
    },
    /** commit ที่ deploy อยู่จริง — ใช้ตอบคำถาม "push แล้วขึ้นหรือยัง" ได้ใน 5 วิ */
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    ts: new Date().toISOString(),
  });
}
