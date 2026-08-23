import { getServiceClient } from "../db";

/**
 * ชีพจรของ cron — เขียนทุกครั้งที่ /api/cron/dispatch ถูกเรียก
 *
 * เหตุผลที่ต้องมี: ตารางเวลาทั้งระบบ (reminder, สรุปกลุ่มตามรอบ, ลบข้อความที่หมดอายุ) ขึ้นกับ
 * pg_cron ที่อยู่นอกโค้ดนี้. เวลามันหยุดเดิน อาการที่เห็นคือ "ไม่มีอะไรเกิดขึ้น" — ไม่มี error
 * ไม่มี log ให้ดู เราจึงเสียเวลาไล่หาบั๊กในโค้ดที่ไม่ได้พัง. ชีพจรทำให้แยกสองเรื่องนี้ออกจากกัน
 *
 * ห้าม throw — cron ที่ทำงานได้แต่บันทึกชีพจรไม่ได้ ยังดีกว่า cron ที่ล้มทั้งรอบเพราะบันทึกพลาด
 */
export async function recordCronTick(result: unknown): Promise<void> {
  try {
    const supabase = getServiceClient();
    await supabase.rpc("upl_cron_tick", { p_result: result ?? null });
  } catch {
    // เงียบโดยตั้งใจ — ดูเหตุผลด้านบน
  }
}

export interface CronHealth {
  lastTickAt: string | null;
  secondsAgo: number | null;
  tickCount: number | null;
  /** เดินอยู่จริงไหม — เผื่อ 5 นาที เพราะรอบปกติคือ 1 นาที */
  healthy: boolean;
}

export async function readCronHealth(): Promise<CronHealth> {
  try {
    const supabase = getServiceClient();
    const { data } = await supabase
      .from("upl_cron_heartbeat")
      .select("last_tick_at, tick_count")
      .eq("id", 1)
      .maybeSingle();

    if (!data?.last_tick_at) return { lastTickAt: null, secondsAgo: null, tickCount: null, healthy: false };

    const last = new Date(data.last_tick_at as string);
    const secondsAgo = Math.round((Date.now() - last.getTime()) / 1000);
    return {
      lastTickAt: last.toISOString(),
      secondsAgo,
      tickCount: Number(data.tick_count ?? 0),
      healthy: secondsAgo <= 300,
    };
  } catch {
    return { lastTickAt: null, secondsAgo: null, tickCount: null, healthy: false };
  }
}
