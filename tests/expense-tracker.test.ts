import { describe, it, expect } from "vitest";
import { parseLedgerIntent } from "@/lib/modules/expense-tracker/parse";
import { categorizeLocal } from "@/lib/modules/expense-tracker/categories";
import { aggregate, periodRange } from "@/lib/modules/expense-tracker/summary";
import {
  buildSummaryFlex,
  buildRecordConfirm,
  buildEntryListFlex,
} from "@/lib/modules/expense-tracker/flex";
import type { LedgerSummary } from "@/lib/modules/expense-tracker/summary";
import type { LedgerRow } from "@/lib/modules/expense-tracker/ledger";

/**
 * Unit tests for the expense-tracker (สมุดรายรับ-รายจ่าย) module.
 *
 * parse.ts / summary.ts / categories.ts are all PURE + DETERMINISTIC (no DB, no live clock):
 * every date-aware call takes an explicit `now`, so results are reproducible. Asia/Bangkok is
 * a fixed UTC+7 offset, so we anchor on a NOW that is noon Bangkok to keep any backdated
 * ("เมื่อวาน"/"วานซืน") wall-clock dates unambiguous regardless of the machine's timezone.
 *
 *   NOW = 2026-07-03T05:00:00Z  ==  2026-07-03 12:00 Bangkok  (Friday)
 */
const NOW = new Date("2026-07-03T05:00:00Z");

// ── parseLedgerIntent ─────────────────────────────────────────────────────────────────────

describe("parseLedgerIntent — record (needs 'จด' prefix)", () => {
  it("basic expense 'จด กาแฟ 50' → one expense entry, amount 50", () => {
    const intent = parseLedgerIntent("จด กาแฟ 50", NOW);
    expect(intent?.action).toBe("record");
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries).toHaveLength(1);
    const e = intent.entries[0];
    expect(e.kind).toBe("expense");
    expect(e.amount).toBe(50);
    expect(e.item).toContain("กาแฟ");
  });

  it("income via leading '+' : 'จด +เงินเดือน 30000'", () => {
    const intent = parseLedgerIntent("จด +เงินเดือน 30000", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].kind).toBe("income");
    expect(intent.entries[0].amount).toBe(30000);
  });

  it("income via keyword (no sign) : 'จด เงินเดือน 30000'", () => {
    const intent = parseLedgerIntent("จด เงินเดือน 30000", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].kind).toBe("income");
    expect(intent.entries[0].amount).toBe(30000);
  });

  it("expense via leading '-' : 'จด -50 ค่ากาแฟ'", () => {
    const intent = parseLedgerIntent("จด -50 ค่ากาแฟ", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].kind).toBe("expense");
    expect(intent.entries[0].amount).toBe(50);
  });

  it("multiplier 'k' : 'จด ค่าเช่า 5k' → 5000", () => {
    const intent = parseLedgerIntent("จด ค่าเช่า 5k", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].amount).toBe(5000);
    expect(intent.entries[0].kind).toBe("expense");
  });

  it("multiplier 'หมื่น' : 'จด โบนัส 2หมื่น' → 20000 income", () => {
    const intent = parseLedgerIntent("จด โบนัส 2หมื่น", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].amount).toBe(20000);
    expect(intent.entries[0].kind).toBe("income");
  });

  it("first item on the SAME line as จด + comma + next line → 3 entries", () => {
    const intent = parseLedgerIntent("จด ข้าว 60, กาแฟ 40\nน้ำมัน 500", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries).toHaveLength(3);
    expect(intent.entries.map((e) => e.amount)).toEqual([60, 40, 500]);
  });

  it("'จด' on its own line, items on the following lines → 2 entries", () => {
    const intent = parseLedgerIntent("จด\nกาแฟ 50\nเงินเดือน 30000", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries).toHaveLength(2);
    expect(intent.entries[0].amount).toBe(50);
    expect(intent.entries[1].kind).toBe("income");
  });

  it("note after '#' : 'จด กาแฟ 50 # ร้านโปรด' → note has ร้านโปรด, item has no #", () => {
    const intent = parseLedgerIntent("จด กาแฟ 50 # ร้านโปรด", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    const e = intent.entries[0];
    expect(e.note).toContain("ร้านโปรด");
    expect(e.item).not.toContain("#");
    expect(e.item).not.toContain("ร้านโปรด");
  });

  it("'จด' alone → record with 0 entries (handler then shows a how-to hint)", () => {
    const intent = parseLedgerIntent("จด", NOW);
    expect(intent?.action).toBe("record");
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries).toHaveLength(0);
  });
});

describe("parseLedgerIntent — 'จด' prefix is REQUIRED to record", () => {
  it("bare 'กาแฟ 50' (no จด) → null — ordinary chat is never recorded", () => {
    expect(parseLedgerIntent("กาแฟ 50", NOW)).toBeNull();
  });
  it("'555' (Thai laughter) → null", () => {
    expect(parseLedgerIntent("555", NOW)).toBeNull();
  });
  it("'จดหมาย 50' → null (จด+หมาย, no boundary → not a record prefix)", () => {
    expect(parseLedgerIntent("จดหมาย 50", NOW)).toBeNull();
  });
});

describe("parseLedgerIntent — backdating (deterministic with fixed NOW)", () => {
  it("'จด กาแฟ 50 เมื่อวาน' → occurredOn 2026-07-02", () => {
    const intent = parseLedgerIntent("จด กาแฟ 50 เมื่อวาน", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].occurredOn).toBe("2026-07-02");
  });

  it("'จด ข้าว 60 วานซืน' → occurredOn 2026-07-01", () => {
    const intent = parseLedgerIntent("จด ข้าว 60 วานซืน", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].occurredOn).toBe("2026-07-01");
  });

  it("no date word → occurredOn defaults to today 2026-07-03", () => {
    const intent = parseLedgerIntent("จด กาแฟ 50", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].occurredOn).toBe("2026-07-03");
  });
});

describe("parseLedgerIntent — unit guard (numbers that are not money)", () => {
  it("'จด ประชุม 10 โมง' → record with 0 entries (time guarded out)", () => {
    const intent = parseLedgerIntent("จด ประชุม 10 โมง", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries).toHaveLength(0);
  });

  it("'จด มา 3 คน' → record with 0 entries (headcount guarded out)", () => {
    const intent = parseLedgerIntent("จด มา 3 คน", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries).toHaveLength(0);
  });

  it("'จด ค่าปรับ 500 บาท' → recorded (บาท forces money)", () => {
    const intent = parseLedgerIntent("จด ค่าปรับ 500 บาท", NOW);
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries[0].amount).toBe(500);
    expect(intent.entries[0].kind).toBe("expense");
  });
});

describe("parseLedgerIntent — todo guard (segments owned by the todo module)", () => {
  it("'เพิ่ม ซื้อของ 500' → null (todo prefix ignored)", () => {
    expect(parseLedgerIntent("เพิ่ม ซื้อของ 500", NOW)).toBeNull();
  });

  it("'ค้าง' → null (todo command, no amount)", () => {
    expect(parseLedgerIntent("ค้าง", NOW)).toBeNull();
  });
});

describe("parseLedgerIntent — commands", () => {
  it("'สรุป' → summary day", () => {
    expect(parseLedgerIntent("สรุป", NOW)).toEqual({ action: "summary", period: "day" });
  });

  it("'วันนี้' → summary day", () => {
    expect(parseLedgerIntent("วันนี้", NOW)).toEqual({ action: "summary", period: "day" });
  });

  it("'สัปดาห์' → summary week", () => {
    expect(parseLedgerIntent("สัปดาห์", NOW)).toEqual({ action: "summary", period: "week" });
  });

  it("'เดือนนี้' → summary month", () => {
    expect(parseLedgerIntent("เดือนนี้", NOW)).toEqual({ action: "summary", period: "month" });
  });

  it("'รายงาน' → report", () => {
    expect(parseLedgerIntent("รายงาน", NOW)).toEqual({ action: "report" });
  });

  it("'ยกเลิก' → undo", () => {
    expect(parseLedgerIntent("ยกเลิก", NOW)).toEqual({ action: "undo" });
  });

  it("'ลบล่าสุด' → undo", () => {
    expect(parseLedgerIntent("ลบล่าสุด", NOW)).toEqual({ action: "undo" });
  });

  it("'ลบ 2' → null (todo delete command; ledger ignores it, never records ฿2)", () => {
    // "ลบ N" is the todo module's delete command. The ledger's TODO_FIRST_TOKEN guard drops
    // any segment starting with ลบ (word-boundary), so it is never mis-recorded as a ฿N entry.
    // Belt-and-suspenders with ROUTER_PRIORITY (assistant runs before expense_tracker).
    expect(parseLedgerIntent("ลบ 2", NOW)).toBeNull();
    // ...but the ledger's OWN undo command "ลบล่าสุด" still works (asserted above).
  });
});

describe("parseLedgerIntent — list command (NEW)", () => {
  // The "list" intent is a simple numbered list of today's entries — distinct from the
  // "summary" graph card. CMD_LIST matches these four exact strings (case-insensitive).
  it("'รายการ' → list", () => {
    expect(parseLedgerIntent("รายการ", NOW)).toEqual({ action: "list" });
  });

  it("'ลิสต์' → list", () => {
    expect(parseLedgerIntent("ลิสต์", NOW)).toEqual({ action: "list" });
  });

  it("'list' → list", () => {
    expect(parseLedgerIntent("list", NOW)).toEqual({ action: "list" });
  });

  it("'LIST' (upper-case) → list (CMD_LIST is case-insensitive)", () => {
    expect(parseLedgerIntent("LIST", NOW)).toEqual({ action: "list" });
  });

  it("'รายการวันนี้' → list", () => {
    expect(parseLedgerIntent("รายการวันนี้", NOW)).toEqual({ action: "list" });
  });

  // ── Regression: list must NOT swallow the existing commands / record / todo paths ──
  it("regression: 'สรุป' still → summary day (NOT list)", () => {
    expect(parseLedgerIntent("สรุป", NOW)).toEqual({ action: "summary", period: "day" });
  });

  it("regression: 'วันนี้' still → summary day (NOT list)", () => {
    expect(parseLedgerIntent("วันนี้", NOW)).toEqual({ action: "summary", period: "day" });
  });

  it("regression: 'จด กาแฟ 50' still → record (not a list command)", () => {
    const intent = parseLedgerIntent("จด กาแฟ 50", NOW);
    expect(intent?.action).toBe("record");
    if (intent?.action !== "record") throw new Error("expected record");
    expect(intent.entries).toHaveLength(1);
    expect(intent.entries[0].amount).toBe(50);
  });

  it("regression: 'ลบ 2' still → null (todo delete; not a ledger list)", () => {
    expect(parseLedgerIntent("ลบ 2", NOW)).toBeNull();
  });
});

describe("parseLedgerIntent — junk / empty", () => {
  it("'สวัสดีครับ' → null", () => {
    expect(parseLedgerIntent("สวัสดีครับ", NOW)).toBeNull();
  });

  it("empty string → null", () => {
    expect(parseLedgerIntent("   ", NOW)).toBeNull();
  });
});

// ── categorizeLocal ───────────────────────────────────────────────────────────────────────

describe("categorizeLocal", () => {
  it("กาแฟ (expense) → กิน", () => {
    expect(categorizeLocal("กาแฟ", "expense")).toBe("กิน");
  });

  it("น้ำมัน (expense) → เดินทาง", () => {
    expect(categorizeLocal("น้ำมัน", "expense")).toBe("เดินทาง");
  });

  it("ค่าไฟ (expense) → บ้าน/บิล", () => {
    expect(categorizeLocal("ค่าไฟ", "expense")).toBe("บ้าน/บิล");
  });

  it("เงินเดือน (income) → เงินเดือน", () => {
    expect(categorizeLocal("เงินเดือน", "income")).toBe("เงินเดือน");
  });

  it("unknown word → อื่นๆ", () => {
    expect(categorizeLocal("อะไรก็ไม่รู้xyz", "expense")).toBe("อื่นๆ");
  });
});

// ── aggregate ─────────────────────────────────────────────────────────────────────────────

describe("aggregate", () => {
  // 2 income + 3 expense across 2 expense categories (กิน 150, เดินทาง 50).
  const entries = [
    { kind: "income" as const, amount: 30000, category: "เงินเดือน" },
    { kind: "income" as const, amount: 2000, category: "โบนัส" },
    { kind: "expense" as const, amount: 100, category: "กิน" },
    { kind: "expense" as const, amount: 50, category: "กิน" },
    { kind: "expense" as const, amount: 50, category: "เดินทาง" },
  ];

  it("totals: income / expense / net / count", () => {
    const s = aggregate(entries);
    expect(s.income).toBe(32000);
    expect(s.expense).toBe(200);
    expect(s.net).toBe(31800);
    expect(s.count).toBe(5);
  });

  it("byCat is expense-only, sorted desc, with correct pct", () => {
    const s = aggregate(entries);
    // income categories (เงินเดือน/โบนัส) must NOT appear in byCat
    expect(s.byCat.map((c) => c.category)).toEqual(["กิน", "เดินทาง"]);
    expect(s.byCat[0]).toMatchObject({ category: "กิน", amount: 150 });
    expect(s.byCat[1]).toMatchObject({ category: "เดินทาง", amount: 50 });
    // pct = amount / total expense (200) * 100
    expect(s.byCat[0].pct).toBeCloseTo(75, 5);
    expect(s.byCat[1].pct).toBeCloseTo(25, 5);
  });

  it("empty input → all zeros, empty byCat", () => {
    const s = aggregate([]);
    expect(s).toMatchObject({ income: 0, expense: 0, net: 0, count: 0 });
    expect(s.byCat).toEqual([]);
  });
});

// ── periodRange ───────────────────────────────────────────────────────────────────────────

describe("periodRange (NOW = Fri 2026-07-03 BKK)", () => {
  it("day → from == to == today, non-empty label", () => {
    const r = periodRange("day", NOW);
    expect(r.from).toBe("2026-07-03");
    expect(r.to).toBe("2026-07-03");
    expect(typeof r.label).toBe("string");
    expect(r.label.length).toBeGreaterThan(0);
  });

  it("week → Mon..Sun containing today (from is Monday, 7-day span)", () => {
    const r = periodRange("week", NOW);
    // Fri 2026-07-03 → Monday of that week is 2026-06-29, Sunday is 2026-07-05.
    expect(r.from).toBe("2026-06-29");
    expect(r.to).toBe("2026-07-05");
    // Monday check + inclusive 7-day span.
    expect(new Date(`${r.from}T00:00:00Z`).getUTCDay()).toBe(1); // 1 = Monday
    const days =
      (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(7);
    expect(r.label.length).toBeGreaterThan(0);
  });

  it("month → from is day 01, to is last day of the month", () => {
    const r = periodRange("month", NOW);
    expect(r.from).toBe("2026-07-01");
    expect(r.to).toBe("2026-07-31"); // July has 31 days
    expect(r.label.length).toBeGreaterThan(0);
  });
});

// ── flex builders (structure only) ────────────────────────────────────────────────────────

describe("flex builders — shape only", () => {
  const summary: LedgerSummary = {
    income: 32000,
    expense: 200,
    net: 31800,
    count: 5,
    byCat: [
      { category: "กิน", amount: 150, pct: 75 },
      { category: "เดินทาง", amount: 50, pct: 25 },
    ],
  };

  it("buildSummaryFlex → flex message with a bubble", () => {
    const msg = buildSummaryFlex(summary, {
      periodLabel: "วันนี้ 3 ก.ค.",
      reportUrl: "https://example.com/ledger/tok123",
    });
    expect(msg.type).toBe("flex");
    expect(typeof msg.altText).toBe("string");
    expect(msg.altText && msg.altText.length).toBeGreaterThan(0);
    expect(msg.contents).toBeDefined();
    expect(msg.contents?.type).toBe("bubble");
    // Quick Reply attached (วันนี้/สัปดาห์/เดือน/รายงาน).
    expect(msg.quickReply?.items.length).toBeGreaterThan(0);
  });

  it("buildRecordConfirm → text OutboundMessage with a quickReply", () => {
    const rows: LedgerRow[] = [
      {
        id: "row-1",
        target_id: "target-1",
        kind: "expense",
        amount: 50,
        category: "กิน",
        note: null,
        raw_text: "กาแฟ",
        occurred_on: "2026-07-03",
        created_at: "2026-07-03T05:00:00.000Z",
        deleted_at: null,
      },
    ];
    const msg = buildRecordConfirm(rows);
    expect(msg.type).toBe("text");
    expect(typeof msg.text).toBe("string");
    expect(msg.text && msg.text.length).toBeGreaterThan(0);
    expect(msg.quickReply).toBeDefined();
    expect(msg.quickReply?.items.length).toBeGreaterThan(0);
    expect(msg.quickReply?.items[0].type).toBe("action");
  });
});

// ── buildEntryListFlex (the simple numbered list card — NEW) ─────────────────────────────────

describe("buildEntryListFlex — shape + item count", () => {
  // Minimal LedgerRow factory; only the fields buildEntryListFlex reads matter, but we
  // populate the full shape so the test stays honest against the LedgerRow contract.
  function row(
    id: string,
    kind: "income" | "expense",
    amount: number,
    category: string,
    raw_text: string | null
  ): LedgerRow {
    return {
      id,
      target_id: "target-1",
      kind,
      amount,
      category,
      note: null,
      raw_text,
      occurred_on: "2026-07-03",
      created_at: `2026-07-03T05:00:0${id.slice(-1)}.000Z`,
      deleted_at: null,
    };
  }

  const rows: LedgerRow[] = [
    row("1", "expense", 50, "กิน", "กาแฟ"),
    row("2", "expense", 500, "เดินทาง", "น้ำมัน"),
    row("3", "income", 30000, "เงินเดือน", "เงินเดือน"),
  ];

  it("3 rows → flex bubble message; altText + count reflect 3 items", () => {
    const msg = buildEntryListFlex(rows, { periodLabel: "วันนี้ 3 ก.ค." });
    expect(msg.type).toBe("flex");
    expect(typeof msg.altText).toBe("string");
    expect(msg.altText).toContain("3 รายการ");
    expect(msg.contents).toBeDefined();
    expect(msg.contents?.type).toBe("bubble");
    // body has exactly one entry box per row (numbered list).
    const body = msg.contents?.body as { contents: unknown[] };
    expect(Array.isArray(body.contents)).toBe(true);
    expect(body.contents).toHaveLength(3);
    // Quick Reply attached.
    expect(msg.quickReply?.items.length).toBeGreaterThan(0);
  });

  it("2 rows → count reflects 2 items (altText + body length)", () => {
    const msg = buildEntryListFlex(rows.slice(0, 2), { periodLabel: "วันนี้ 3 ก.ค." });
    expect(msg.type).toBe("flex");
    expect(msg.altText).toContain("2 รายการ");
    const body = msg.contents?.body as { contents: unknown[] };
    expect(body.contents).toHaveLength(2);
  });

  it("empty array → a valid message that does not throw (friendly hint, with quickReply)", () => {
    let msg: ReturnType<typeof buildEntryListFlex>;
    expect(() => {
      msg = buildEntryListFlex([], { periodLabel: "วันนี้ 3 ก.ค." });
    }).not.toThrow();
    // The builder returns a text hint (not an empty card) — assert it is a usable message.
    msg = buildEntryListFlex([], { periodLabel: "วันนี้ 3 ก.ค." });
    expect(["text", "flex"]).toContain(msg.type);
    if (msg.type === "text") {
      expect(typeof msg.text).toBe("string");
      expect(msg.text && msg.text.length).toBeGreaterThan(0);
    } else {
      expect(msg.contents).toBeDefined();
    }
    expect(msg.quickReply?.items.length).toBeGreaterThan(0);
  });
});
