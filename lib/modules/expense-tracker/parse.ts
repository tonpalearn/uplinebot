// ───────────────────────────────────────────────────────────────────────────
// parse.ts — แยกข้อความธรรมชาติ → intent (บันทึก/สรุป/รายงาน/ยกเลิก) ของสมุดรายรับ-รายจ่าย
// PURE + DETERMINISTIC: ไม่มี DB, ไม่เรียก new Date() ภายใน — ทุกอย่างคำนวณจาก `now` ที่รับเข้า.
// Ported from EunJod (src/lib/parser.ts). ต่างจากเดิม: คืน occurredOn (YYYY-MM-DD ตามเวลา
// Asia/Bangkok) เลย แทนที่จะเป็น DateHint แบบ raw — และเพิ่ม command-detection + todo/unit guards.
//
// Timezone: Asia/Bangkok = UTC+7 คงที่ (ไม่มี DST) จึงเลื่อน +7 ชม. เพื่ออ่านวันแบบ wall-clock
// จาก `now` (เหมือน lib/modules/assistant/datetime.ts) — ไม่พึ่ง timezone ของ server.
// ───────────────────────────────────────────────────────────────────────────

import type { LedgerKind } from "./categories";

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface ParsedEntry {
  kind: LedgerKind;
  amount: number; // เก็บค่าบวกเสมอ — kind เป็นตัวบอกทิศ (income/expense)
  item: string;
  note: string | null;
  occurredOn: string; // YYYY-MM-DD ตามเวลา Asia/Bangkok
}

/** intent ที่ handler จะ switch — null = ไม่ทำอะไร (บอทเงียบ ไม่จดขยะ) */
export type LedgerIntent =
  | { action: "record"; entries: ParsedEntry[] }
  | { action: "summary"; period: "day" | "week" | "month" }
  | { action: "report" }
  | { action: "undo" }
  | null;

// ── คำใบ้ทิศทาง (นอกเหนือจากเครื่องหมาย +/-) ────────────────────────────────────
/** คำที่บอกว่าเป็น "รายรับ" */
const INCOME_WORDS = [
  "เงินเดือน", "โบนัส", "รายรับ", "เงินเข้า", "ขาย", "ได้รับ", "ค่าคอม", "ทิป",
  "เงินคืน", "คืนเงิน", "ดอกเบี้ย", "ปันผล", "salary", "bonus", "refund", "income",
];

/** ตัวคูณท้ายจำนวน */
const SUFFIX: Record<string, number> = {
  k: 1000, พัน: 1000, หมื่น: 10000, แสน: 100000, ล้าน: 1000000,
};

/** หน่วยที่ "ไม่ใช่เงิน" — ถ้าเลขตามด้วยคำพวกนี้ จะไม่นับเป็นจำนวนเงิน (กันจดเวลา/จำนวนคน)
 *  เว้นแต่มี "บาท"/"฿" กำกับ (เช็คแยกใน pickAmount). กัน "ประชุม 10 โมง" ไม่ให้กลายเป็นรายการ. */
const NON_MONEY_UNIT =
  /^\s*(โมง|นาฬิกา|น\.|ทุ่ม|ชม\.?|ชั่วโมง|นาที|วินาที|คน|ท่าน|ปี|ขวบ|กม\.?|กิโล|เมตร|ก\.?ก\.?|กรัม|%|เปอร์เซ็นต์|องศา)/;

/** คำแรกของบรรทัดที่เป็นของ "โมดูล todo" — ข้ามไป ไม่จดเป็นเงิน.
 *  รวม "ลบ" (คำสั่ง "ลบ N" ลบงานของ todo) — boundary \s|$ จับ "ลบ 2"/"ลบ" แต่ไม่โดน "ลบล่าสุด"
 *  (undo ของ ledger เอง ซึ่งถูกจับที่ระดับ command ก่อนถึงจุดนี้อยู่แล้ว) */
const TODO_FIRST_TOKEN = /^(เพิ่ม|ค้าง|วางแผน|เลื่อน|ลบ)(?:\s|$)/;

interface AmountHit {
  value: number;
  start: number;
  end: number;
}

/** เลือกจำนวนเงินจากข้อความหนึ่งท่อน — คืน null ถ้าไม่มีเลขที่เป็นเงิน */
function pickAmount(s: string): AmountHit | null {
  const re = /(\d+(?:\.\d+)?)\s*(k|พัน|หมื่น|แสน|ล้าน)?/gi;
  const hits: {
    num: number; suf?: string; start: number; end: number; baht: boolean; unit: boolean;
  }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const after = s.slice(m.index + m[0].length);
    hits.push({
      num: parseFloat(m[1]),
      suf: m[2]?.toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
      baht: /^\s*(บาท|฿)/.test(after),
      unit: NON_MONEY_UNIT.test(after),
    });
  }
  // ตัดตัวที่เป็นหน่วยไม่ใช่เงินทิ้ง (เว้นแต่มี บาท/฿ กำกับ)
  const usable = hits.filter((h) => h.baht || !h.unit);
  if (usable.length === 0) return null;

  // ลำดับความสำคัญ: มี "บาท/฿" > มีตัวคูณ (k/พัน..) > ตัวเลขท้ายสุด
  const chosen =
    usable.find((h) => h.baht) || usable.find((h) => h.suf) || usable[usable.length - 1];

  const mult = chosen.suf ? SUFFIX[chosen.suf] : 1;
  let end = chosen.end;
  const tail = s.slice(end).match(/^\s*(บาท|฿)/);
  if (tail) end += tail[0].length;
  return { value: chosen.num * mult, start: chosen.start, end };
}

// ── Asia/Bangkok date helpers (fixed UTC+7, no DST) ────────────────────────────
interface BkkYmd {
  y: number;
  m: number; // 1-12
  d: number;
}

/** วันปัจจุบัน (wall-clock Bangkok) ของ instant */
function bkkToday(now: Date): BkkYmd {
  const s = new Date(now.getTime() + BKK_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** บวกจำนวนวันแบบ wall-clock (normalize ผ่าน UTC) */
function addDays(ymd: BkkYmd, days: number): BkkYmd {
  const base = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

/** YYYY-MM-DD สำหรับ wall-clock Bangkok date */
function ymdKey(ymd: BkkYmd): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}

/** ปีพุทธ (>2500) → ค.ศ.; 2 หลัก → 20xx */
function normalizeYear(y: number): number {
  if (y >= 2500) return y - 543;
  if (y < 100) return 2000 + y;
  return y;
}

/** คำบอกวันแบบสัมพัทธ์ (เมื่อวาน/วานซืน/วันนี้) */
const REL_WORDS: [RegExp, number][] = [
  [/(?:เมื่อ)?วานซืน/, -2],
  [/เมื่อวาน(?:นี้)?|วานนี้/, -1],
  [/วันนี้/, 0],
];

/** แยกคำใบ้วันที่ออกจากท่อนข้อความ + คืนวัน (BkkYmd) และข้อความที่ตัดวันออกแล้ว */
function extractDate(s: string, today: BkkYmd): { ymd: BkkYmd; rest: string } {
  // "N วันก่อน" / "N วันที่แล้ว"
  let m = s.match(/(\d+)\s*วัน(?:ก่อน|ที่แล้ว)/);
  if (m) {
    return { ymd: addDays(today, -parseInt(m[1], 10)), rest: s.replace(m[0], " ") };
  }

  // คำบอกวัน (เมื่อวาน/วานซืน/วันนี้)
  for (const [re, days] of REL_WORDS) {
    const mm = s.match(re);
    if (mm) return { ymd: addDays(today, days), rest: s.replace(mm[0], " ") };
  }

  // วันที่แบบ d/m หรือ d/m/yy(yy) — มี "/" จึงไม่ชนกับจำนวนเงิน
  m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const d = +m[1];
    const mo = +m[2];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const y = m[3] ? normalizeYear(+m[3]) : today.y;
      return { ymd: { y, m: mo, d }, rest: s.replace(m[0], " ") };
    }
  }

  return { ymd: today, rest: s };
}

/** แปลงหนึ่งท่อนข้อความ → ParsedEntry หรือ null (ถ้าไม่มีจำนวนเงิน / เป็นคำสั่ง todo) */
function parseSegment(seg: string, today: BkkYmd): ParsedEntry | null {
  // Todo guard: ท่อนที่ขึ้นต้นด้วยคำสั่งของโมดูล todo ให้ข้าม (โมดูล todo เป็นเจ้าของ)
  if (TODO_FIRST_TOKEN.test(seg.trim())) return null;

  let work = seg;
  let note: string | null = null;

  // โน้ตหลัง # (หรือ //)
  const noteMatch = work.match(/[#]\s*(.+)$/) || work.match(/\/\/\s*(.+)$/);
  if (noteMatch && typeof noteMatch.index === "number") {
    note = noteMatch[1].trim() || null;
    work = work.slice(0, noteMatch.index).trim();
  }

  // วันที่ย้อนหลัง (ตัดออกก่อนหาจำนวนเงิน เพื่อไม่ให้เลขวันถูกอ่านเป็นยอด)
  const { ymd, rest } = extractDate(work, today);
  work = rest;

  // เครื่องหมายกำหนดชนิดชัดเจน
  let force: LedgerKind | undefined;
  const t = work.trimStart();
  if (t.startsWith("+")) {
    force = "income";
    work = t.slice(1);
  } else if (t.startsWith("-") || t.startsWith("−")) {
    force = "expense";
    work = t.slice(1);
  }

  const amt = pickAmount(work);
  if (!amt) return null;

  let item = (work.slice(0, amt.start) + " " + work.slice(amt.end))
    .replace(/\s+/g, " ")
    .replace(/^[+\-−]/, "")
    .trim();
  if (!item) item = "(ไม่ระบุ)";

  const hay = (item + " " + (note ?? "")).toLowerCase();
  const kind: LedgerKind =
    force ?? (INCOME_WORDS.some((w) => hay.includes(w)) ? "income" : "expense");

  return { kind, amount: amt.value, item, note, occurredOn: ymdKey(ymd) };
}

/**
 * แยกข้อความเป็นหลายรายการ (คั่นด้วย , ; หรือขึ้นบรรทัดใหม่) — คืน [] ถ้าไม่พบจำนวนเงินเลย.
 * รวมตัวคั่นหลักพัน "1,000" → "1000" ก่อน เพื่อไม่ให้ , ไปตัดผิด.
 */
function parseEntries(text: string, today: BkkYmd): ParsedEntry[] {
  const cleaned = text.replace(/(\d),(\d)/g, "$1$2");
  const segments = cleaned.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const out: ParsedEntry[] = [];
  for (const seg of segments) {
    const e = parseSegment(seg, today);
    if (e) out.push(e);
  }
  return out;
}

// ── Command detection ──────────────────────────────────────────────────────────
// ตรวจทั้งข้อความ (trim, ไม่สนตัวพิมพ์ใหญ่-เล็ก) ก่อนตกไปโหมด "record".
const CMD_DAY = /^(สรุป|สรุปวันนี้|วันนี้|สิ้นวัน)$/i;
const CMD_WEEK = /^(สรุปสัปดาห์|สัปดาห์|อาทิตย์นี้|สรุปอาทิตย์)$/i;
const CMD_MONTH = /^(สรุปเดือน|เดือนนี้|เดือน)$/i;
const CMD_REPORT = /^(รายงาน|report|กราฟ)$/i;
// undo: ไม่จับ "ลบ" เดี่ยว — นั่นเป็นของโมดูล todo
const CMD_UNDO = /^(ยกเลิก|ลบล่าสุด|undo)$/i;

/**
 * แปลงข้อความ → LedgerIntent. ตรวจคำสั่งทั้งข้อความก่อน (day/week/month/report/undo)
 * ถ้าไม่ใช่คำสั่ง → โหมด record (แยกหลายรายการ). คืน null ถ้าไม่มีรายการที่ถูกต้องเลย
 * (บอทจะเงียบ ไม่จดขยะ).
 */
export function parseLedgerIntent(text: string, now: Date): LedgerIntent {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  // คำสั่ง (ทั้งข้อความตรงกับ pattern เดียว)
  if (CMD_DAY.test(trimmed)) return { action: "summary", period: "day" };
  if (CMD_WEEK.test(trimmed)) return { action: "summary", period: "week" };
  if (CMD_MONTH.test(trimmed)) return { action: "summary", period: "month" };
  if (CMD_REPORT.test(trimmed)) return { action: "report" };
  if (CMD_UNDO.test(trimmed)) return { action: "undo" };

  // record
  const today = bkkToday(now);
  const entries = parseEntries(trimmed, today);
  if (entries.length === 0) return null;
  return { action: "record", entries };
}
