import { describe, it, expect } from "vitest";
import { parseThaiDateTime, formatThaiDueAt } from "../lib/modules/assistant/datetime";

/**
 * Tests for the Thai natural-language date/time parser (lib/modules/assistant/datetime.ts).
 *
 * All cases are anchored on a fixed NOW so results are deterministic. Asia/Bangkok is a
 * fixed UTC+7 offset, so a Bangkok wall-clock HH:MM maps to an absolute UTC instant of
 * (HH-7):MM on the same Bangkok day.
 *
 *   NOW = 2026-07-02T03:00:00Z  ==  2026-07-02 10:00 Bangkok  (a Thursday / วันพฤหัส)
 */
const NOW = new Date("2026-07-02T03:00:00Z");

/** Assert the parsed dueAt equals a given Bangkok wall-clock Y/M/D H:M. */
function expectBkk(due: Date | null, y: number, m: number, d: number, hh: number, mm: number) {
  expect(due).not.toBeNull();
  const utc = new Date(due!.getTime());
  // Reconstruct Bangkok wall clock by adding 7h and reading UTC fields.
  const bkk = new Date(utc.getTime() + 7 * 60 * 60 * 1000);
  expect(bkk.getUTCFullYear()).toBe(y);
  expect(bkk.getUTCMonth() + 1).toBe(m);
  expect(bkk.getUTCDate()).toBe(d);
  expect(bkk.getUTCHours()).toBe(hh);
  expect(bkk.getUTCMinutes()).toBe(mm);
}

describe("parseThaiDateTime — relative days", () => {
  it("วันนี้ + HH:MM", () => {
    const r = parseThaiDateTime("ประชุม วันนี้ 14:00", NOW);
    expectBkk(r.dueAt, 2026, 7, 2, 14, 0);
    expect(r.cleanedText).toBe("ประชุม");
  });

  it("พรุ่งนี้ + HH.MM (dot form)", () => {
    const r = parseThaiDateTime("ส่งงาน พรุ่งนี้ 09.30", NOW);
    expectBkk(r.dueAt, 2026, 7, 3, 9, 30);
    expect(r.cleanedText).toBe("ส่งงาน");
  });

  it("มะรืน + no time defaults to 09:00", () => {
    const r = parseThaiDateTime("เอกสาร มะรืน", NOW);
    expectBkk(r.dueAt, 2026, 7, 4, 9, 0);
    expect(r.cleanedText).toBe("เอกสาร");
  });

  it("มะรืนนี้ variant", () => {
    const r = parseThaiDateTime("มะรืนนี้ เที่ยง กินข้าว", NOW);
    expectBkk(r.dueAt, 2026, 7, 4, 12, 0);
    expect(r.cleanedText).toContain("กินข้าว");
  });
});

describe("parseThaiDateTime — weekdays (next occurrence)", () => {
  it("ศุกร์ (Fri) from Thursday → next day", () => {
    const r = parseThaiDateTime("นัดหมอ ศุกร์ 10:00", NOW);
    expectBkk(r.dueAt, 2026, 7, 3, 10, 0);
    expect(r.cleanedText).toContain("นัดหมอ");
  });

  it("จันทร์ (Mon) from Thursday → +4 days", () => {
    const r = parseThaiDateTime("วันจันทร์ 08:00 วิ่ง", NOW);
    expectBkk(r.dueAt, 2026, 7, 6, 8, 0);
    expect(r.cleanedText).toContain("วิ่ง");
  });

  it("same weekday (พฤหัส) with a time → today", () => {
    const r = parseThaiDateTime("พฤหัส 15:00 โทรลูกค้า", NOW);
    expectBkk(r.dueAt, 2026, 7, 2, 15, 0);
  });

  it("same weekday (พฤหัส) with NO time → +7 days", () => {
    const r = parseThaiDateTime("ประชุมใหญ่ วันพฤหัส", NOW);
    expectBkk(r.dueAt, 2026, 7, 9, 9, 0);
  });
});

describe("parseThaiDateTime — explicit DD/MM[/YYYY]", () => {
  it("DD/MM future this year", () => {
    const r = parseThaiDateTime("จ่ายบิล 25/12 09:00", NOW);
    expectBkk(r.dueAt, 2026, 12, 25, 9, 0);
  });

  it("DD/MM already-passed this year rolls to next year", () => {
    const r = parseThaiDateTime("รดน้ำต้นไม้ 01/01", NOW);
    expectBkk(r.dueAt, 2027, 1, 1, 9, 0);
  });

  it("DD/MM/YYYY Gregorian", () => {
    const r = parseThaiDateTime("ทริป 15/08/2026 07:00", NOW);
    expectBkk(r.dueAt, 2026, 8, 15, 7, 0);
  });

  it("DD/MM/YYYY Buddhist year (2569 → 2026)", () => {
    const r = parseThaiDateTime("สอบ 20/09/2569 13:00", NOW);
    expectBkk(r.dueAt, 2026, 9, 20, 13, 0);
  });
});

describe("parseThaiDateTime — time expressions", () => {
  it("เที่ยงคืน = 00:00", () => {
    const r = parseThaiDateTime("วันนี้ เที่ยงคืน", NOW);
    expectBkk(r.dueAt, 2026, 7, 2, 0, 0);
  });

  it("บ่าย 2 = 14:00", () => {
    const r = parseThaiDateTime("พรุ่งนี้ บ่าย 2 ประชุม", NOW);
    expectBkk(r.dueAt, 2026, 7, 3, 14, 0);
    expect(r.cleanedText).toContain("ประชุม");
  });

  it("3 ทุ่ม = 21:00", () => {
    const r = parseThaiDateTime("วันนี้ 3 ทุ่ม ดูหนัง", NOW);
    expectBkk(r.dueAt, 2026, 7, 2, 21, 0);
  });

  it("HH โมง", () => {
    const r = parseThaiDateTime("พรุ่งนี้ 8 โมง", NOW);
    expectBkk(r.dueAt, 2026, 7, 3, 8, 0);
  });

  it("เช้า = 09:00, เย็น = 17:00 (date-word + named time)", () => {
    const morning = parseThaiDateTime("พรุ่งนี้ เช้า", NOW);
    expectBkk(morning.dueAt, 2026, 7, 3, 9, 0);
    const evening = parseThaiDateTime("พรุ่งนี้ เย็น", NOW);
    expectBkk(evening.dueAt, 2026, 7, 3, 17, 0);
  });

  it("time-only (no date) resolves to today", () => {
    const r = parseThaiDateTime("18:30", NOW);
    expectBkk(r.dueAt, 2026, 7, 2, 18, 30);
  });
});

describe("parseThaiDateTime — no match", () => {
  it("returns null + original text when nothing recognized", () => {
    const r = parseThaiDateTime("ซื้อของที่ตลาด", NOW);
    expect(r.dueAt).toBeNull();
    expect(r.cleanedText).toBe("ซื้อของที่ตลาด");
  });

  it("empty input", () => {
    const r = parseThaiDateTime("   ", NOW);
    expect(r.dueAt).toBeNull();
    expect(r.cleanedText).toBe("");
  });
});

describe("formatThaiDueAt", () => {
  it("today → 'วันนี้ HH:MM'", () => {
    const due = new Date("2026-07-02T07:00:00Z"); // 14:00 BKK
    expect(formatThaiDueAt(due, NOW)).toBe("วันนี้ 14:00");
  });

  it("tomorrow → 'พรุ่งนี้ HH:MM'", () => {
    const due = new Date("2026-07-03T02:00:00Z"); // 09:00 BKK
    expect(formatThaiDueAt(due, NOW)).toBe("พรุ่งนี้ 09:00");
  });

  it("far date → 'D <mon> HH:MM'", () => {
    const due = new Date("2026-12-25T02:00:00Z"); // 09:00 BKK, 25 ธ.ค.
    expect(formatThaiDueAt(due, NOW)).toBe("25 ธ.ค. 09:00");
  });
});
