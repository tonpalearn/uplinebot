import { listActiveWatches, purgeOldMessages, updateWatchConfig, lastReportAt, type WatchConfig } from "./store";
import { runSummary } from "./handler";
import { getServiceClient } from "../../db";

/**
 * รอบงานตามเวลาของผู้ช่วยเฝ้ากลุ่ม — ถูกเรียกจาก /api/cron/dispatch
 *
 * ทำ 2 อย่างในรอบเดียว:
 *   1. กลุ่มไหนถึงรอบสรุปแล้ว → สรุปแล้วส่ง
 *   2. ลบข้อความที่เก็บเกินกำหนดของทุกกลุ่ม — **นี่คือส่วนที่ทำให้สัญญา "เก็บสั้นที่สุด"
 *      เป็นจริง** ถ้ารอบนี้ไม่ทำงาน ข้อมูลบทสนทนาของคนอื่นจะค้างในระบบไปเรื่อย ๆ
 *      จึงทำ purge ก่อนเสมอ และทำแม้กลุ่มนั้นจะสรุปพลาด
 */

/** "HH:MM" ตามเวลาไทยของ `now` */
function bkkHHMM(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(11, 16);
}

/**
 * ถึงเวลาสรุปหรือยัง
 *
 * - interval: ครบ N นาทีนับจากรายงานล่าสุด (ไม่เคยส่ง = ถึงเวลา)
 * - times: ตรงกับนาฬิกาที่ตั้งไว้ ภายในหน้าต่างความคลาดเคลื่อนของ cron
 * - off: ไม่สรุปตามเวลา (เฉพาะคำสำคัญ/สั่งเอง)
 */
export function isDue(cfg: WatchConfig, lastReportAt: Date | null, now: Date, windowMinutes = 10): boolean {
  if (!cfg.active) return false;

  if (cfg.scheduleKind === "off") return false;

  if (cfg.scheduleKind === "interval") {
    if (!lastReportAt) return true;
    return now.getTime() - lastReportAt.getTime() >= cfg.intervalMinutes * 60_000;
  }

  // times: ตรงนาฬิกาที่ตั้งไว้ไหม — เทียบเป็นนาทีเพื่อรองรับ cron ที่มาไม่ตรงเป๊ะ
  const nowHHMM = bkkHHMM(now);
  const [nh, nm] = nowHHMM.split(":").map(Number);
  const nowMin = nh * 60 + nm;

  for (const t of (cfg.reportTimes ?? "").split(/[,\s]+/).filter(Boolean)) {
    const [h, m] = t.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) continue;
    const diff = nowMin - (h * 60 + m);
    if (diff < 0 || diff > windowMinutes) continue;
    // ตรงเวลาแล้ว — แต่ต้องไม่เพิ่งส่งไปในหน้าต่างเดียวกัน (กันส่งซ้ำเมื่อ cron ยิงถี่)
    if (lastReportAt && now.getTime() - lastReportAt.getTime() < (windowMinutes + 5) * 60_000) {
      return false;
    }
    return true;
  }
  return false;
}

/** botId ของกลุ่มนั้น (targets ผูกกับ bot) */
async function botIdForTarget(targetId: string): Promise<string | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_targets")
    .select("bot_id")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read bot for target ${targetId}: ${error.message}`);
  return (data?.bot_id as string | null) ?? null;
}

export interface WatchCronResult {
  checked: number;
  summarized: number;
  purged: number;
  errors: string[];
  /**
   * เหตุผลการตัดสินใจของแต่ละกลุ่มในรอบนี้ — ตอบคำถาม "ทำไมกลุ่มนี้ไม่ได้สรุป"
   * โดยไม่ต้องไล่โค้ดหรือเดา. เก็บเฉพาะค่าที่ใช้ตัดสินจริง ไม่มีเนื้อหาบทสนทนา
   */
  decisions: string[];
}

export async function runGroupWatchCron(now = new Date()): Promise<WatchCronResult> {
  const result: WatchCronResult = { checked: 0, summarized: 0, purged: 0, errors: [], decisions: [] };

  let watches: WatchConfig[];
  try {
    watches = await listActiveWatches();
  } catch (err) {
    result.errors.push(`list: ${err instanceof Error ? err.message : err}`);
    return result;
  }

  for (const cfg of watches) {
    result.checked += 1;

    // 1) ลบของเก่าก่อนเสมอ — ทำแยก try เพื่อให้การสรุปพลาดไม่ทำให้ purge ไม่ทำงาน
    try {
      result.purged += await purgeOldMessages(cfg.targetId, cfg.retentionDays);
    } catch (err) {
      result.errors.push(`purge ${cfg.targetId}: ${err instanceof Error ? err.message : err}`);
    }

    // 2) ถึงรอบสรุปหรือยัง
    try {
      const last = await lastReportAt(cfg.targetId);
      const tag = cfg.targetId.slice(0, 8);
      if (!isDue(cfg, last, now)) {
        result.decisions.push(
          `${tag}: ยังไม่ถึงรอบ (${cfg.scheduleKind}/${cfg.intervalMinutes}น. last=${last ? last.toISOString() : "ไม่เคย"})`
        );
        continue;
      }

      const botId = await botIdForTarget(cfg.targetId);
      if (!botId) {
        result.errors.push(`no bot for target ${cfg.targetId}`);
        continue;
      }

      const r = await runSummary(cfg, botId, `กลุ่ม ${tag}`, "scheduled");
      if (r.delivered) result.summarized += 1;
      result.decisions.push(
        `${tag}: ถึงรอบ pending=${r.count} ขั้นต่ำ=${cfg.minMessages} ส่ง=${r.delivered ? "สำเร็จ" : "ไม่สำเร็จ"}`
      );
      // ส่งไม่ออกทั้งที่ถึงรอบแล้ว = ต้องดังพอให้เห็นใน /api/health ไม่ใช่หายเงียบ
      // (นี่คืออาการที่ทำให้ "ตั้งเวลาแล้วสรุปไม่มา" ไล่หาสาเหตุไม่ได้)
      for (const f of r.failures) {
        result.errors.push(`deliver ${cfg.targetId.slice(0, 8)}: ${f}`);
      }

      // แตะ last_alert_at ไว้ด้วย เพื่อไม่ให้คำสำคัญเด้งซ้ำทันทีหลังเพิ่งส่งสรุปรอบไป
      if (r.delivered) {
        await updateWatchConfig(cfg.targetId, { lastAlertAt: now.toISOString() });
      }
    } catch (err) {
      result.errors.push(`summary ${cfg.targetId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}
