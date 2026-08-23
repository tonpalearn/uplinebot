import type { WatchConfig } from "./store";

// ───────────────────────────────────────────────────────────────────────────
// schedule.ts — "รอบรายงาน" ในภาษาที่คนอ่านรู้เรื่อง (PURE ไม่แตะ DB)
//
// ทำไมต้องมีไฟล์นี้: เดิมเรามีแค่ค่าในฐานข้อมูล (schedule_kind/interval_minutes/report_times)
// แต่คนใช้ไม่เคยเห็นมันเลย — บอทบอกแค่ "ตั้งแล้ว" ซึ่งตอบไม่ได้ว่า **"แล้วสรุปจะมาตอนไหน"**
// ทุกฟังก์ชันในนี้จึงแปลงค่าดิบ → ประโยคที่ตอบคำถามนั้นได้ตรง ๆ
//
// เวลาทั้งหมดคิดเป็นเวลาไทย (UTC+7) เพราะผู้ใช้ทั้งหมดอยู่ไทย และ cron ก็เทียบไทยอยู่แล้ว
// ───────────────────────────────────────────────────────────────────────────

const BKK_OFFSET_MS = 7 * 3600_000;

/** "HH:MM" ตามเวลาไทยของเวลา UTC ที่ให้มา */
export function bkkHHMM(d: Date): string {
  return new Date(d.getTime() + BKK_OFFSET_MS).toISOString().slice(11, 16);
}

/** ช่วงเวลาที่รองรับ — ถี่กว่านี้กวนคน ห่างกว่านี้ข้อความค้างเยอะจนสรุปไม่มีประโยชน์ */
export const MIN_INTERVAL = 15;
export const MAX_INTERVAL = 24 * 60;

/** "ทุก 30 นาที" / "ทุก 4 ชั่วโมง" — ชั่วโมงลงตัวพูดเป็นชั่วโมง อ่านง่ายกว่า */
export function intervalLabel(minutes: number): string {
  if (minutes % 60 === 0) return `ทุก ${minutes / 60} ชั่วโมง`;
  if (minutes > 60) return `ทุก ${Math.floor(minutes / 60)} ชม. ${minutes % 60} นาที`;
  return `ทุก ${minutes} นาที`;
}

/** บรรยายรอบปัจจุบันแบบสั้น — ใช้ทั้งบนการ์ดและในข้อความสถานะ */
export function describeSchedule(cfg: Pick<WatchConfig, "scheduleKind" | "intervalMinutes" | "reportTimes">): string {
  if (cfg.scheduleKind === "off") return "เฉพาะตอนเจอคำสำคัญ (ไม่สรุปตามเวลา)";
  if (cfg.scheduleKind === "times") {
    const t = splitTimes(cfg.reportTimes);
    return t.length ? `ทุกวันเวลา ${t.join(" · ")} น.` : "ยังไม่ได้ตั้งเวลา";
  }
  return intervalLabel(cfg.intervalMinutes);
}

/** อ่าน report_times จาก DB → ลิสต์ "HH:MM" ที่เรียงแล้ว */
export function splitTimes(stored: string | null): string[] {
  return (stored ?? "")
    .split(/[,\s]+/)
    .filter((s) => /^\d{2}:\d{2}$/.test(s))
    .sort();
}

/**
 * สรุปรอบถัดไปจะมาเมื่อไหร่ — คืน null ถ้าไม่สรุปตามเวลา
 *
 * interval นับต่อจาก "รายงานล่าสุด" ไม่ใช่จากตอนนี้ เพราะ cron ก็ตัดสินแบบนั้น (isDue)
 * ถ้าคำนวณจาก now จะบอกเวลาที่ช้ากว่าความจริงทุกครั้งที่เพิ่งมีรายงานไปไม่นาน
 */
export function nextReportAt(
  cfg: Pick<WatchConfig, "scheduleKind" | "intervalMinutes" | "reportTimes">,
  lastReportAt: Date | null,
  now: Date
): Date | null {
  if (cfg.scheduleKind === "off") return null;

  if (cfg.scheduleKind === "interval") {
    const base = lastReportAt ?? now;
    const next = new Date(base.getTime() + cfg.intervalMinutes * 60_000);
    // เลยกำหนดไปแล้ว (เช่น เพิ่งเปิดเครื่อง/cron หยุดไปพัก) = รอบหน้าคือรอบถัดไปที่ cron เดิน
    return next.getTime() <= now.getTime() ? now : next;
  }

  const times = splitTimes(cfg.reportTimes);
  if (times.length === 0) return null;

  const nowBkk = new Date(now.getTime() + BKK_OFFSET_MS);
  const nowMin = nowBkk.getUTCHours() * 60 + nowBkk.getUTCMinutes();

  for (const t of times) {
    const [h, m] = t.split(":").map(Number);
    if (h * 60 + m > nowMin) {
      const d = new Date(nowBkk);
      d.setUTCHours(h, m, 0, 0);
      return new Date(d.getTime() - BKK_OFFSET_MS);
    }
  }
  // หมดเวลาของวันนี้แล้ว → ตัวแรกของพรุ่งนี้
  const [h, m] = times[0].split(":").map(Number);
  const d = new Date(nowBkk);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(h, m, 0, 0);
  return new Date(d.getTime() - BKK_OFFSET_MS);
}

/** "รายงานถัดไป ~14:30 น. (อีก 2 ชม. 15 นาที)" — ประโยคที่คนถามจริง ๆ */
export function nextReportLabel(
  cfg: Pick<WatchConfig, "scheduleKind" | "intervalMinutes" | "reportTimes">,
  lastReportAt: Date | null,
  now: Date
): string | null {
  const next = nextReportAt(cfg, lastReportAt, now);
  if (!next) return null;

  const diffMin = Math.max(0, Math.round((next.getTime() - now.getTime()) / 60_000));
  const inWords =
    diffMin < 1 ? "รอบถัดไปที่ระบบตรวจ"
    : diffMin < 60 ? `อีก ${diffMin} นาที`
    : diffMin % 60 === 0 ? `อีก ${diffMin / 60} ชม.`
    : `อีก ${Math.floor(diffMin / 60)} ชม. ${diffMin % 60} นาที`;

  return `${bkkHHMM(next)} น. (${inWords})`;
}
