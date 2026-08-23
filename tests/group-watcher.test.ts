import { describe, it, expect } from "vitest";
import { parseWatchIntent, matchKeywords, splitStored } from "../lib/modules/group-watcher/parse";
import { validateSummary, fallbackSummary } from "../lib/modules/group-watcher/summarize";
import { isDue } from "../lib/modules/group-watcher/cron";
import { buildStatusText, buildSummaryCard } from "../lib/modules/group-watcher/flex";
import { GroupWatcherModule } from "../lib/modules/group-watcher/handler";
import type { WatchConfig } from "../lib/modules/group-watcher/store";
import type { LineEvent } from "../lib/modules/types";

/**
 * ผู้ช่วยเฝ้ากลุ่ม (โมดูลที่ 17).
 *
 * สิ่งที่เทสต์ชุดนี้ล็อกไว้ เรียงตามความเสียหายถ้าหลุด:
 *  1. **matchesIntent ต้องรับเฉพาะคำสั่งของตัวเอง** — ถ้ารับข้อความทุกอันเมื่อไหร่
 *     router (first-match-wins) จะกลืนคำสั่งของทุกโมดูลที่อยู่หลังมัน
 *  2. **ค่าเริ่มต้นต้องไม่ระบุชื่อผู้พูด** — นี่คือเส้นแบ่งระหว่าง "สรุปงาน" กับ "สอดส่องรายคน"
 *  3. คำสั่งความโปร่งใส (เฝ้าอะไรอยู่ / ไม่สรุปข้อความผม) ต้องใช้ได้เสมอ
 */

function cfg(over: Partial<WatchConfig> = {}): WatchConfig {
  return {
    targetId: "t1", tenantId: "tn1", active: true,
    reportToUser: "U1", reportToTarget: null,
    scheduleKind: "interval", intervalMinutes: 240, reportTimes: null,
    keywords: null, urgentKeywords: null,
    includeNames: false, retentionDays: 3, minMessages: 3,
    alertCooldownMinutes: 10, lastAlertAt: null,
    ...over,
  };
}

const textEvent = (t: string): LineEvent => ({
  type: "message",
  message: { id: "m1", type: "text", text: t },
  source: { type: "group", userId: "U1", groupId: "G1" },
  timestamp: Date.now(),
});

// ── 1. กันโมดูลกลืน router ──────────────────────────────────────────────────────
describe("matchesIntent — ต้องรับเฉพาะคำสั่งของตัวเอง", () => {
  it("รับคำสั่งของโมดูลนี้", () => {
    for (const c of ["เฝ้ากลุ่มนี้", "สรุปตอนนี้", "เฝ้าอะไรอยู่", "ทุก 30 นาที", "ไม่สรุปข้อความผม"]) {
      expect(GroupWatcherModule.matchesIntent(textEvent(c), {})).toBe(true);
    }
  });

  it("**ไม่รับ** บทสนทนาทั่วไป — ไม่งั้นจะกลืนคำสั่งของโมดูลอื่นทั้งระบบ", () => {
    for (const c of ["สวัสดีครับ", "กิน เช้า ข้าวสวย 100g", "ถาม ราคาเท่าไหร่", "opb2026", "กาแฟ 50"]) {
      expect(GroupWatcherModule.matchesIntent(textEvent(c), {})).toBe(false);
    }
  });

  it("ไม่รับ event ที่ไม่ใช่ข้อความตัวอักษร (รูป/สติกเกอร์ ไม่ถูกแตะเลย)", () => {
    const img: LineEvent = {
      type: "message", message: { id: "m", type: "image" },
      source: { type: "group", userId: "U1", groupId: "G1" }, timestamp: Date.now(),
    };
    expect(GroupWatcherModule.matchesIntent(img, {})).toBe(false);
  });

  it("ข้อความหลายบรรทัด = บทสนทนา ไม่ใช่คำสั่ง", () => {
    expect(parseWatchIntent("เฝ้ากลุ่มนี้\nแล้วก็อย่างอื่น")).toBeNull();
  });
});

// ── 2. คำสั่ง ─────────────────────────────────────────────────────────────────
describe("parseWatchIntent", () => {
  it("เปิด/ปิด/สรุปเดี๋ยวนี้", () => {
    expect(parseWatchIntent("เฝ้ากลุ่มนี้")).toEqual({ action: "watch_start" });
    expect(parseWatchIntent("เลิกเฝ้า")).toEqual({ action: "watch_stop" });
    expect(parseWatchIntent("สรุปตอนนี้")).toEqual({ action: "summarize_now" });
  });

  it("รอบเวลาแบบ 'ทุก N' รับทั้งนาทีและชั่วโมง", () => {
    expect(parseWatchIntent("ทุก 30 นาที")).toEqual({ action: "set_interval", minutes: 30 });
    expect(parseWatchIntent("รายงานทุก 2 ชม.")).toEqual({ action: "set_interval", minutes: 120 });
    expect(parseWatchIntent("สรุปทุก 4 ชั่วโมง")).toEqual({ action: "set_interval", minutes: 240 });
  });

  it("รอบเวลานอกช่วงที่รองรับ → help (ไม่เงียบหาย)", () => {
    expect(parseWatchIntent("ทุก 2 นาที")).toEqual({ action: "help" });     // ถี่เกิน
    expect(parseWatchIntent("ทุก 48 ชม.")).toEqual({ action: "help" });      // ห่างเกิน
  });

  it("ระบุเวลานาฬิกา — เรียงและตัดตัวที่ไม่ใช่เวลาออก", () => {
    expect(parseWatchIntent("รายงานเวลา 18:00, 09:00")).toEqual({
      action: "set_times", times: ["09:00", "18:00"],
    });
    expect(parseWatchIntent("รายงานเวลา 99:99")).toEqual({ action: "help" });
  });

  it("คำสำคัญ vs คำด่วน แยกกัน และคั่นด้วยคอมมา", () => {
    expect(parseWatchIntent("คำสำคัญ ราคา, ยกเลิก")).toEqual({
      action: "set_keywords", keywords: ["ราคา", "ยกเลิก"], urgent: false,
    });
    expect(parseWatchIntent("คำเตือน ไม่พอใจ, ร้องเรียน")).toEqual({
      action: "set_keywords", keywords: ["ไม่พอใจ", "ร้องเรียน"], urgent: true,
    });
  });

  it("ปลายทาง + การระบุชื่อ", () => {
    expect(parseWatchIntent("ส่งสรุปให้ผม")).toEqual({ action: "set_report_to", to: "me" });
    expect(parseWatchIntent("ส่งสรุปที่นี่")).toEqual({ action: "set_report_to", to: "here" });
    expect(parseWatchIntent("ระบุชื่อ")).toEqual({ action: "set_names", on: true });
    expect(parseWatchIntent("ไม่ระบุชื่อ")).toEqual({ action: "set_names", on: false });
  });

  it("คำสั่งความโปร่งใส — ใครในกลุ่มก็ใช้ได้", () => {
    expect(parseWatchIntent("เฝ้าอะไรอยู่")).toEqual({ action: "status" });
    expect(parseWatchIntent("ไม่สรุปข้อความผม")).toEqual({ action: "optout", on: true });
    expect(parseWatchIntent("สรุปข้อความผมได้")).toEqual({ action: "optout", on: false });
  });
});

describe("matchKeywords / splitStored", () => {
  it("เทียบไม่สนตัวพิมพ์ใหญ่เล็ก และคืนเฉพาะคำที่เจอ", () => {
    expect(matchKeywords("ลูกค้าขอ CANCEL ออเดอร์", ["cancel", "ราคา"])).toEqual(["cancel"]);
    expect(matchKeywords("คุยเรื่องทั่วไป", ["cancel"])).toEqual([]);
  });

  it("อ่านค่าที่เก็บใน DB กลับมาเป็นลิสต์ (คอมมา/บรรทัดใหม่)", () => {
    expect(splitStored("ราคา, ยกเลิก\nด่วน")).toEqual(["ราคา", "ยกเลิก", "ด่วน"]);
    expect(splitStored(null)).toEqual([]);
  });
});

// ── 3. ตรวจผลจาก AI ────────────────────────────────────────────────────────────
describe("validateSummary", () => {
  const ok = {
    topics: ["ลูกค้าถามราคาแพ็กเกจ"], actions: ["ส่งใบเสนอราคา"],
    openQuestions: ["ส่งของวันไหน"], facts: ["ยอด 12,000 บาท"],
    needsAttention: true, attentionReason: "ลูกค้าทวงครั้งที่สอง",
  };

  it("ผลปกติผ่าน", () => {
    expect(validateSummary(ok)).toMatchObject({ needsAttention: true, topics: ["ลูกค้าถามราคาแพ็กเกจ"] });
  });

  it("ว่างทุกหมวด → null (ไม่รบกวนเจ้าของด้วยสรุปเปล่า)", () => {
    expect(validateSummary({ ...ok, topics: [], actions: [], openQuestions: [], facts: [] })).toBeNull();
  });

  it("ค่าที่ไม่ใช่อ็อบเจกต์ → null", () => {
    expect(validateSummary(null)).toBeNull();
    expect(validateSummary("nope")).toBeNull();
  });

  it("ตัดรายการที่ยาวผิดปกติ/ไม่ใช่ข้อความออก", () => {
    const r = validateSummary({ ...ok, topics: ["ก".repeat(400), 123, "ปกติ"] });
    expect(r?.topics).toEqual(["ปกติ"]);
  });

  it("needsAttention ต้องเป็น true จริง ๆ เท่านั้น (ค่าอื่นถือว่าไม่ด่วน)", () => {
    expect(validateSummary({ ...ok, needsAttention: "yes" })?.needsAttention).toBe(false);
  });

  it("สรุปสำรองใช้ได้เมื่อ AI ล่ม — ไม่ปล่อยให้เงียบ", () => {
    expect(fallbackSummary(12).topics[0]).toContain("12");
  });
});

// ── 4. ถึงรอบสรุปหรือยัง ────────────────────────────────────────────────────────
describe("isDue", () => {
  const now = new Date("2026-08-19T02:05:00Z"); // 09:05 น. ไทย

  it("interval: ยังไม่เคยส่ง = ถึงเวลา", () => {
    expect(isDue(cfg({ intervalMinutes: 60 }), null, now)).toBe(true);
  });

  it("interval: ครบ N นาทีแล้วถึงจะส่ง", () => {
    const c = cfg({ intervalMinutes: 60 });
    expect(isDue(c, new Date(now.getTime() - 30 * 60_000), now)).toBe(false);
    expect(isDue(c, new Date(now.getTime() - 61 * 60_000), now)).toBe(true);
  });

  it("times: ตรงนาฬิกาที่ตั้งไว้ (มีหน้าต่างเผื่อ cron มาไม่ตรงเป๊ะ)", () => {
    const c = cfg({ scheduleKind: "times", reportTimes: "09:00,18:00" });
    expect(isDue(c, null, now)).toBe(true);                                   // 09:05 อยู่ในหน้าต่าง
    expect(isDue(c, null, new Date("2026-08-19T05:00:00Z"))).toBe(false);      // 12:00 ไม่ตรง
  });

  it("times: เพิ่งส่งไปในหน้าต่างเดียวกัน = ไม่ส่งซ้ำ", () => {
    const c = cfg({ scheduleKind: "times", reportTimes: "09:00" });
    expect(isDue(c, new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it("off = ไม่สรุปตามเวลา (เฉพาะคำสำคัญ/สั่งเอง)", () => {
    expect(isDue(cfg({ scheduleKind: "off" }), null, now)).toBe(false);
  });

  it("ปิดการเฝ้าแล้วไม่ทำงาน", () => {
    expect(isDue(cfg({ active: false }), null, now)).toBe(false);
  });
});

// ── 5. ความเป็นส่วนตัวบนหน้าจอ ─────────────────────────────────────────────────
describe("การ์ด — ความโปร่งใสต่อคนในกลุ่ม", () => {
  const flat = (o: unknown) => JSON.stringify(o);

  it("สถานะบอกครบ: ส่งให้ใคร รอบไหน เก็บนานแค่ไหน และวิธีขอไม่ถูกสรุป", () => {
    const t = buildStatusText(cfg({ keywords: "ราคา" }), "กลุ่มทดสอบ", 2) as { text: string };
    expect(t.text).toContain("แชทส่วนตัว");
    expect(t.text).toContain("ทุก 4 ชั่วโมง");
    expect(t.text).toContain("3 วัน");
    expect(t.text).toContain("ไม่สรุปข้อความผม");
    expect(t.text).toContain("2 คน");             // จำนวนคนที่ขอไม่ถูกสรุป
  });

  it("กลุ่มที่ไม่ได้เฝ้า ต้องบอกชัดว่าไม่มีการเก็บข้อความ", () => {
    const t = buildStatusText(null, "กลุ่มทดสอบ", 0) as { text: string };
    expect(t.text).toContain("ไม่ได้ถูกสรุป");
  });

  it("การ์ดสรุปบอกเสมอว่าระบุชื่อหรือไม่ระบุ", () => {
    const s = validateSummary({
      topics: ["คุยเรื่องส่งของ"], actions: [], openQuestions: [], facts: [],
      needsAttention: false, attentionReason: "",
    })!;
    const anon = flat(buildSummaryCard({
      groupName: "ก", summary: s, messageCount: 5, periodLabel: "09:00–10:00 น.", includeNames: false,
    }).contents);
    expect(anon).toContain("ไม่ระบุชื่อผู้พูด");
  });

  it("เรื่องด่วนต้องอยู่บนสุดของการ์ด", () => {
    const s = validateSummary({
      topics: ["เรื่องทั่วไป"], actions: [], openQuestions: [], facts: [],
      needsAttention: true, attentionReason: "ลูกค้าไม่พอใจ",
    })!;
    const card = buildSummaryCard({
      groupName: "ก", summary: s, messageCount: 9, periodLabel: "-", includeNames: false,
    });
    const body = (card.contents as { body: { contents: unknown[] } }).body.contents;
    expect(flat(body[0])).toContain("ควรรีบดู");
  });
});
