import { describe, it, expect } from "vitest";
import {
  describeSchedule,
  nextReportAt,
  nextReportLabel,
  intervalLabel,
  splitTimes,
} from "../lib/modules/group-watcher/schedule";
import { parseWatchIntent } from "../lib/modules/group-watcher/parse";
import { buildScheduleCard } from "../lib/modules/group-watcher/flex";
import type { WatchConfig } from "../lib/modules/group-watcher/store";

/**
 * รอบรายงาน — ส่วนที่ต้นบอกว่า "ตอนนี้ยังไม่เห็นเลย"
 *
 * บทเรียนของรอบนี้: ความสามารถมีอยู่ในโค้ดครบ แต่ไม่มีทางใดในตัวสินค้าที่บอกผู้ใช้ว่ามันมี
 * เทสต์ชุดนี้จึงล็อกทั้งสองด้าน — ตรรกะเวลาถูก **และ** ข้อความ/การ์ดพูดถึงมันจริง
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

describe("อ่านรอบออกมาเป็นภาษาคน", () => {
  it("ชั่วโมงลงตัวพูดเป็นชั่วโมง ไม่ใช่ 240 นาที", () => {
    expect(intervalLabel(240)).toBe("ทุก 4 ชั่วโมง");
    expect(intervalLabel(60)).toBe("ทุก 1 ชั่วโมง");
    expect(intervalLabel(30)).toBe("ทุก 30 นาที");
    expect(intervalLabel(90)).toBe("ทุก 1 ชม. 30 นาที");
  });

  it("แบบระบุนาฬิกา", () => {
    expect(describeSchedule(cfg({ scheduleKind: "times", reportTimes: "09:00,18:00" })))
      .toBe("ทุกวันเวลา 09:00 · 18:00 น.");
  });

  it("ปิดรอบเวลา = บอกให้ชัดว่าเหลือแค่คำสำคัญ", () => {
    expect(describeSchedule(cfg({ scheduleKind: "off" }))).toContain("คำสำคัญ");
  });

  it("ตั้ง times ไว้แต่ค่าว่าง → ไม่โกหกว่าตั้งแล้ว", () => {
    expect(describeSchedule(cfg({ scheduleKind: "times", reportTimes: null })))
      .toBe("ยังไม่ได้ตั้งเวลา");
  });

  it("ค่าที่ไม่ใช่เวลาถูกคัดทิ้ง", () => {
    expect(splitTimes("09:00, ด่วน, 18:00")).toEqual(["09:00", "18:00"]);
  });
});

describe("รายงานถัดไปจะมาตอนไหน", () => {
  const now = new Date("2026-08-23T05:00:00Z"); // 12:00 น. ไทย

  it("interval นับต่อจากรายงานล่าสุด ไม่ใช่จากตอนนี้", () => {
    // เพิ่งส่งไป 30 นาทีก่อน รอบ 1 ชม. → อีก 30 นาที ไม่ใช่อีก 1 ชม.
    const last = new Date(now.getTime() - 30 * 60_000);
    const next = nextReportAt(cfg({ intervalMinutes: 60 }), last, now)!;
    expect(Math.round((next.getTime() - now.getTime()) / 60_000)).toBe(30);
  });

  it("ยังไม่เคยส่ง → นับจากตอนนี้", () => {
    const next = nextReportAt(cfg({ intervalMinutes: 60 }), null, now)!;
    expect(Math.round((next.getTime() - now.getTime()) / 60_000)).toBe(60);
  });

  it("เลยกำหนดมานานแล้ว (cron เคยหยุด) → ไม่ย้อนอดีต", () => {
    const last = new Date(now.getTime() - 10 * 3600_000);
    expect(nextReportAt(cfg({ intervalMinutes: 60 }), last, now)!.getTime())
      .toBeGreaterThanOrEqual(now.getTime());
  });

  it("times: หยิบเวลาถัดไปของวันนี้", () => {
    const c = cfg({ scheduleKind: "times", reportTimes: "09:00,18:00" });
    const next = nextReportAt(c, null, now)!; // ตอนนี้ 12:00 ไทย
    expect(next.toISOString()).toBe("2026-08-23T11:00:00.000Z"); // 18:00 ไทย
  });

  it("times: เลยเวลาสุดท้ายของวันแล้ว → ตัวแรกของพรุ่งนี้", () => {
    const evening = new Date("2026-08-23T14:00:00Z"); // 21:00 น. ไทย
    const c = cfg({ scheduleKind: "times", reportTimes: "09:00,18:00" });
    const next = nextReportAt(c, null, evening)!;
    expect(next.toISOString()).toBe("2026-08-24T02:00:00.000Z"); // 09:00 ไทยพรุ่งนี้
  });

  it("off → ไม่มีรอบถัดไป (ไม่ใช่ 'อีก 0 นาที')", () => {
    expect(nextReportAt(cfg({ scheduleKind: "off" }), null, now)).toBeNull();
    expect(nextReportLabel(cfg({ scheduleKind: "off" }), null, now)).toBeNull();
  });

  it("ป้ายบอกทั้งเวลานาฬิกาและอีกกี่นาที", () => {
    const label = nextReportLabel(cfg({ intervalMinutes: 90 }), null, now)!;
    expect(label).toContain("13:30 น.");
    expect(label).toContain("อีก 1 ชม. 30 นาที");
  });
});

describe("ผู้ใช้ต้องหาเจอ — ไม่ใช่แค่มีในโค้ด", () => {
  it("คำที่คนจะพิมพ์เพื่อหาการตั้งรอบ ต้องเปิดเมนูได้", () => {
    for (const t of ["ตั้งรอบ", "ความถี่", "รอบรายงาน", "ตั้งความถี่", "เวลารายงาน", "รอบ"]) {
      expect(parseWatchIntent(t)).toEqual({ action: "schedule_menu" });
    }
  });

  it("'ตั้งเวลา' เปล่า ๆ ไม่ถูกกลืน — คนพิมพ์เพื่อตั้งเตือนก็ได้", () => {
    expect(parseWatchIntent("ตั้งเวลา")).toBeNull();
  });

  it("พิมพ์เวลาโดยไม่ต้องมีคำว่า 'รายงาน' นำหน้าก็ได้", () => {
    expect(parseWatchIntent("เวลา 09:00, 18:00")).toEqual({
      action: "set_times", times: ["09:00", "18:00"],
    });
  });

  it("การ์ดตอนเริ่มเฝ้าต้องพูดถึงรอบ + มีปุ่มให้กดเปลี่ยน", () => {
    const card = buildScheduleCard({
      cfg: cfg(), groupName: "กลุ่มทดสอบ",
      nextLabel: "16:00 น. (อีก 4 ชม.)", justStarted: true,
    });
    const json = JSON.stringify(card);
    expect(json).toContain("ทุก 4 ชั่วโมง");        // รอบปัจจุบัน
    expect(json).toContain("รายงานถัดไป");           // ตอบว่าจะมาตอนไหน
    expect(json).toContain("เวลา 09:00, 18:00");     // ปุ่มที่กดแล้วส่งคำสั่งจริง
    expect(json).toContain("ไม่สรุปข้อความผม");      // ยังประกาศสิทธิ์ให้คนในกลุ่มเหมือนเดิม
    expect(card.altText).toContain("ทุก 4 ชั่วโมง"); // เห็นตั้งแต่หน้ารายการแชท
  });

  it("ปุ่มบนการ์ดส่งข้อความที่ parser รับได้จริง (ไม่ใช่ข้อความตาย)", () => {
    const json = JSON.stringify(buildScheduleCard({ cfg: cfg(), groupName: "g", nextLabel: null }));
    const cmds = [...json.matchAll(/"type":"message","label":"[^"]*","text":"([^"]+)"/g)].map((m) => m[1]);
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) expect(parseWatchIntent(c)).not.toBeNull();
  });

  it("รอบที่ตั้งอยู่ถูกทำเครื่องหมาย ◉ ให้เห็นว่าอันไหนใช้อยู่", () => {
    const json = JSON.stringify(buildScheduleCard({
      cfg: cfg({ scheduleKind: "times", reportTimes: "09:00,18:00" }),
      groupName: "g", nextLabel: null,
    }));
    expect(json).toContain("◉  เช้า-เย็น 09:00 · 18:00");
  });
});

// ── ส่งไม่ออกต้องดัง ไม่ใช่เงียบ ────────────────────────────────────────────────
describe("เวลาสรุปส่งไม่ถึงมือ ต้องบอกได้ว่าเพราะอะไร", () => {
  it("deliverSummary คืนเหตุผลที่พลาด ไม่ใช่แค่ null", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/modules/group-watcher/handler.ts", "utf8")
    );
    // ต้องอ่าน status/body ที่ LINE ตอบมา ไม่ใช่ดูแค่ r.ok แล้วทิ้ง
    expect(src).toContain("failures.push");
    expect(src).toContain("HTTP ${r.status}");
    // ไม่ได้ตั้งปลายทางเลย = คนละเรื่องกับส่งแล้วโดนปฏิเสธ ต้องแยกออกจากกัน
    expect(src).toContain("ยังไม่ได้ตั้งปลายทาง");
  });

  it("cron ยกเหตุผลขึ้นไปที่ errors[] เพื่อให้เห็นใน /api/health", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/modules/group-watcher/cron.ts", "utf8")
    );
    expect(src).toContain("r.failures");
    expect(src).toContain("result.errors.push");
  });
});

// ── บทเรียนจากการรันจริงบน prod ────────────────────────────────────────────────
describe("บั๊กที่เจอตอนเปิดใช้จริง — ล็อกไว้ไม่ให้กลับมา", () => {
  it("อ่านข้อความรอสรุปต้องผ่านฟังก์ชัน SQL ไม่ใช่ select หลายคอลัมน์ผ่าน REST", async () => {
    // select("id,display_name,text,sent_at") เคยคืน 0 แถวเงียบ ๆ ทั้งที่นับได้ 7
    // ขอทีละคอลัมน์ได้ครบ แต่ขอพร้อมกันได้ศูนย์ — กลุ่มที่มีข้อความค้างจึงไม่เคยถูกสรุป
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/modules/group-watcher/store.ts", "utf8")
    );
    const getPending = src.slice(src.indexOf("export async function getPending"));
    expect(getPending).toContain('rpc("upl_watch_pending"');
    expect(getPending.slice(0, getPending.indexOf("}"))).not.toContain('.select("id, display_name');
  });

  it("รอบสรุปต้องจองสิทธิ์ก่อนรัน และปลดธงใน finally", async () => {
    // cron ยิงทุก 1 นาที แต่รอบหนึ่งอาจนานกว่านั้น → รอบที่ทับกันเคยส่งสรุปซ้ำมาแล้วจริง
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/modules/group-watcher/cron.ts", "utf8")
    );
    expect(src).toContain("tryBeginSummary");
    expect(src.indexOf("tryBeginSummary")).toBeLessThan(src.indexOf("runSummary(cfg"));
    // ปลดธงต้องอยู่ใน finally ไม่งั้นรอบที่ล้มจะทำให้กลุ่มค้างจนกว่า stale timeout จะหมด
    expect(src).toMatch(/finally\s*\{[^}]*endSummary/s);
  });
});
