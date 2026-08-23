// ───────────────────────────────────────────────────────────────────────────
// parse.ts — คำสั่งของผู้ช่วยเฝ้ากลุ่ม (PURE + DETERMINISTIC ไม่แตะ DB)
//
// โมดูลนี้ต่างจากโมดูลอื่นตรงที่ "ข้อความส่วนใหญ่ในกลุ่มไม่ใช่คำสั่ง" — มันคือบทสนทนาที่เรา
// เก็บไว้สรุป. parse จึงมีหน้าที่ตอบแค่ว่า "ข้อความนี้เป็นคำสั่งของโมดูลหรือเปล่า"
// ถ้าไม่ใช่ = คืน null แล้ว handler จะเก็บเป็นบทสนทนาแทน (ไม่ตอบอะไรกลับ)
// ───────────────────────────────────────────────────────────────────────────

export type WatchIntent =
  /** เริ่มเฝ้ากลุ่มนี้ (พิมพ์ในกลุ่ม) */
  | { action: "watch_start" }
  /** หยุดเฝ้า */
  | { action: "watch_stop" }
  /** ขอสรุปเดี๋ยวนี้ ไม่รอรอบ */
  | { action: "summarize_now" }
  /** ตั้งรอบเวลา: ทุก N นาที/ชั่วโมง */
  | { action: "set_interval"; minutes: number }
  /** ตั้งเวลาแบบระบุนาฬิกา เช่น 09:00,18:00 */
  | { action: "set_times"; times: string[] }
  /** ตั้งคำสำคัญที่เจอแล้วเด้งทันที */
  | { action: "set_keywords"; keywords: string[]; urgent: boolean }
  /** ส่งสรุปให้ใคร — เข้าแชทส่วนตัวคนสั่ง หรือกลุ่มนี้ */
  | { action: "set_report_to"; to: "me" | "here" }
  /** เปิด/ปิดการระบุชื่อคนพูดในสรุป */
  | { action: "set_names"; on: boolean }
  /** ความโปร่งใส: ใครก็ถามได้ว่ากำลังเฝ้าอะไร ส่งให้ใคร */
  | { action: "status" }
  /** สมาชิกขอไม่ให้สรุปข้อความตัวเอง / ขอกลับเข้าสรุป */
  | { action: "optout"; on: boolean }
  /** ขอดู/ขอเปลี่ยน "รอบรายงาน" — เปิดการ์ดที่กดเลือกความถี่ได้ */
  | { action: "schedule_menu" }
  /** วิธีใช้ */
  | { action: "help" }
  | null;

// ── คำสั่ง ─────────────────────────────────────────────────────────────────────
const CMD_START = /^(?:เฝ้ากลุ่ม(?:นี้)?|เริ่มเฝ้า|สรุปกลุ่มนี้ให้หน่อย|watch)$/i;
const CMD_STOP = /^(?:เลิกเฝ้า|หยุดเฝ้า|ปิดเฝ้ากลุ่ม|unwatch)$/i;
const CMD_NOW = /^(?:สรุปตอนนี้|สรุปเลย|สรุปกลุ่ม|สรุปให้หน่อย|summarize)$/i;
const CMD_STATUS = /^(?:เฝ้าอะไรอยู่|สถานะเฝ้า|ใครดูอยู่|watch\s*status)$/i;
const CMD_HELP = /^(?:วิธีเฝ้ากลุ่ม|ช่วยเฝ้ากลุ่ม|help\s*watch)$/i;
/**
 * "ตั้งรอบ" · "ความถี่" · "รอบรายงาน" — เปิดเมนูเลือกความถี่
 * จงใจไม่รับคำว่า "ตั้งเวลา" เปล่า ๆ เพราะกว้างเกินไป (คนพิมพ์เพื่อจะตั้งเตือนก็ได้)
 * ต้องมีคำว่า รอบ/ความถี่/รายงาน กำกับเสมอ
 */
const CMD_SCHEDULE_MENU =
  /^(?:ตั้ง|เปลี่ยน|ดู|แก้)?\s*(?:รอบ(?:รายงาน|สรุป|ส่ง)?|ความถี่|เวลารายงาน|เวลาสรุป|schedule)$/i;
const CMD_OPTOUT = /^(?:ไม่สรุปข้อความ(?:ของ)?(?:ผม|ฉัน|หนู|เรา)|ขอไม่ถูกสรุป|optout)$/i;
const CMD_OPTIN = /^(?:สรุปข้อความ(?:ของ)?(?:ผม|ฉัน|หนู|เรา)ได้|ขอกลับเข้าสรุป|optin)$/i;

/** "รายงานทุก 30 นาที" · "สรุปทุก 2 ชม." · "ทุก 4 ชั่วโมง" */
const CMD_INTERVAL = /^(?:รายงาน|สรุป|เฝ้า)?\s*ทุก\s*(\d+)\s*(นาที|นาท|ชม\.?|ชั่วโมง|hour|hr|min)/i;
/** "รายงานเวลา 09:00, 18:00" */
const CMD_TIMES = /^(?:(?:รายงาน|สรุป|ส่ง)\s*)?(?:เวลา|ตอน)\s+(.+)$/i;
/** "คำสำคัญ ด่วน, ยกเลิก" · "คำเตือน โกรธ, ไม่พอใจ" */
const CMD_KEYWORDS = /^(?:คำสำคัญ|keyword[s]?)\s+(.+)$/i;
const CMD_URGENT = /^(?:คำเตือน|คำด่วน|urgent)\s+(.+)$/i;
/** "ส่งสรุปให้ผม" / "ส่งสรุปที่นี่" */
const CMD_TO_ME = /^(?:ส่งสรุป(?:ให้|มาที่)?(?:ผม|ฉัน|เรา|ส่วนตัว)|รายงานส่วนตัว)$/i;
const CMD_TO_HERE = /^(?:ส่งสรุป(?:ที่|ใน)?นี่|รายงานในกลุ่มนี้|สรุปลงกลุ่มนี้)$/i;
/** "ระบุชื่อ" / "ไม่ระบุชื่อ" */
const CMD_NAMES_ON = /^(?:ระบุชื่อ|ใส่ชื่อ|บอกว่าใครพูด)$/i;
const CMD_NAMES_OFF = /^(?:ไม่ระบุชื่อ|ไม่ต้องใส่ชื่อ|ปิดชื่อ)$/i;

/** แปลงหน่วยเวลาที่พิมพ์ → นาที */
function toMinutes(n: number, unit: string): number {
  return /ชม|ชั่วโมง|hour|hr/i.test(unit) ? n * 60 : n;
}

/** "09:00, 18:30" → ["09:00","18:30"] · ทิ้งอันที่ไม่ใช่เวลา */
function parseTimes(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[,\s]+/)) {
    const m = raw.trim().match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    out.push(`${String(h).padStart(2, "0")}:${m[2]}`);
  }
  return Array.from(new Set(out)).sort();
}

/** คั่นด้วยคอมมา (กติกาเดียวกับ aliases ของฐานอาหาร — เคยพลาดเพราะใช้เว้นวรรคมาแล้ว) */
function parseList(s: string): string[] {
  return Array.from(
    new Set(
      s
        .split(/[,;\n]+/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= 40)
    )
  ).slice(0, 30);
}

export function parseWatchIntent(text: string): WatchIntent {
  const line = (text ?? "").trim();
  if (!line) return null;
  // คำสั่งเป็นบรรทัดเดียวเสมอ — ข้อความยาวหลายบรรทัดคือบทสนทนา ไม่ใช่คำสั่ง
  if (line.includes("\n")) return null;

  if (CMD_HELP.test(line)) return { action: "help" };
  // ต้องอยู่ก่อน CMD_TIMES — ไม่งั้น "เวลารายงาน" จะถูกอ่านเป็น "รายการเวลา" ที่ว่างเปล่า
  if (CMD_SCHEDULE_MENU.test(line)) return { action: "schedule_menu" };
  if (CMD_START.test(line)) return { action: "watch_start" };
  if (CMD_STOP.test(line)) return { action: "watch_stop" };
  if (CMD_NOW.test(line)) return { action: "summarize_now" };
  if (CMD_STATUS.test(line)) return { action: "status" };
  if (CMD_OPTOUT.test(line)) return { action: "optout", on: true };
  if (CMD_OPTIN.test(line)) return { action: "optout", on: false };
  if (CMD_TO_ME.test(line)) return { action: "set_report_to", to: "me" };
  if (CMD_TO_HERE.test(line)) return { action: "set_report_to", to: "here" };
  if (CMD_NAMES_ON.test(line)) return { action: "set_names", on: true };
  if (CMD_NAMES_OFF.test(line)) return { action: "set_names", on: false };

  const iv = line.match(CMD_INTERVAL);
  if (iv) {
    const minutes = toMinutes(parseInt(iv[1], 10), iv[2]);
    // นอกช่วงที่ DB ยอมรับ (15 นาที – 24 ชม.) → ถือว่าอ่านไม่ออก ให้ help บอกช่วงที่ใช้ได้
    if (minutes >= 15 && minutes <= 1440) return { action: "set_interval", minutes };
    return { action: "help" };
  }

  const tm = line.match(CMD_TIMES);
  if (tm) {
    const times = parseTimes(tm[1]);
    if (times.length > 0) return { action: "set_times", times };
    return { action: "help" };
  }

  const urg = line.match(CMD_URGENT);
  if (urg) {
    const keywords = parseList(urg[1]);
    if (keywords.length > 0) return { action: "set_keywords", keywords, urgent: true };
    return { action: "help" };
  }

  const kw = line.match(CMD_KEYWORDS);
  if (kw) {
    const keywords = parseList(kw[1]);
    if (keywords.length > 0) return { action: "set_keywords", keywords, urgent: false };
    return { action: "help" };
  }

  return null; // ไม่ใช่คำสั่ง = เป็นบทสนทนาที่ต้องเก็บไว้สรุป
}

/**
 * ข้อความนี้มีคำสำคัญตัวไหนบ้าง (เทียบแบบไม่สนตัวพิมพ์ใหญ่เล็ก)
 * ใช้ทั้งกับ keywords ปกติและ urgent_keywords
 */
export function matchKeywords(text: string, list: string[]): string[] {
  const hay = (text ?? "").toLowerCase();
  return list.filter((k) => k && hay.includes(k.toLowerCase()));
}

/** "a, b, c" → ["a","b","c"] — ใช้อ่านค่าที่เก็บใน DB กลับมา */
export function splitStored(s: string | null | undefined): string[] {
  return (s ?? "")
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
