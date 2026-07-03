import type { OutboundMessage, QuickReplyItem } from "../types";
import { categoryEmoji } from "./categories";
import type { LedgerSummary } from "./summary";
import type { LedgerRow } from "./ledger";

/**
 * Flex + plain-text builders for the expense-tracker (สมุดรายรับ-รายจ่าย).
 *
 * Flex is NOT themeable (LINE renders it server-side), so every color here is a FIXED hex —
 * same convention as lib/modules/assistant/flex.ts. The web report (/ledger/<token>) is the
 * theme-aware surface; this is the in-chat card.
 *
 * buildRecordConfirm  → concise "✅ บันทึก N รายการ: …" text + Quick Reply.
 * buildSummaryFlex    → the polished "graph card": net balance header, income/expense/net
 *                       rows, then per-category HORIZONTAL BARS (the graph) + a web-report
 *                       button. Quick Reply (วันนี้/สัปดาห์/เดือน) attached.
 * buildSummaryText    → plain-text fallback (totals + category lines).
 */

// ── palette (fixed hex; Flex can't read CSS vars) ──────────────────────────────
const COLOR_TEXT = "#1F2933";
const COLOR_MUTED = "#7B8794";
const COLOR_GREEN = "#0E7C66"; // รายรับ / net ≥ 0
const COLOR_RED = "#C0341D"; // รายจ่าย / net < 0
const COLOR_SEP = "#E4E7EB";
const COLOR_TRACK = "#EEF1F4"; // พื้นหลังแท่งกราฟ (ราง)
const COLOR_HEADER_BG = "#FFFFFF";
const COLOR_FOOTER_BG = "#FAFBFC";
const COLOR_BTN = "#0E7C66"; // ปุ่มดูรายงานเว็บ

/** จานสีคงที่สำหรับแท่งกราฟแต่ละหมวด (วนซ้ำถ้าหมวดเกินจำนวนสี) */
const BAR_COLORS = [
  "#0E7C66", // teal-green
  "#2563EB", // blue
  "#B45309", // amber
  "#7C3AED", // purple
  "#C0341D", // red
  "#0891B2", // cyan
  "#B7791F", // gold
  "#65A30D", // lime
];

/** จำนวนหมวดสูงสุดที่โชว์เป็นแท่งกราฟในการ์ด */
const MAX_BARS = 6;

export interface SummaryFlexOpts {
  periodLabel: string;
  reportUrl: string;
  /** true = มาจาก Quick Reply/สรุปแบบเร็ว (สงวนไว้ปรับ heading ในอนาคต) */
  quick?: boolean;
}

// ── money formatting ───────────────────────────────────────────────────────────
/** จัดรูปแบบเงินบาท เช่น 1234.5 → "1,234.50" (ตัด .00 ออกถ้าเป็นจำนวนเต็ม) — ใช้ th-TH */
function formatTHB(n: number): string {
  const abs = Math.abs(n);
  const hasFraction = Math.round(abs * 100) % 100 !== 0;
  return abs.toLocaleString("th-TH", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/** "+30,000" / "−50" — income บวก, expense ลบ (ใช้ − ตัวยาว ตามสเปก) */
function signed(kind: "income" | "expense", amount: number): string {
  return (kind === "income" ? "+" : "−") + formatTHB(amount);
}

/** net พร้อมเครื่องหมาย: "+…" ถ้า ≥ 0, "−…" ถ้าติดลบ */
function signedNet(net: number): string {
  return (net >= 0 ? "+" : "−") + formatTHB(net);
}

// ── Quick Reply ────────────────────────────────────────────────────────────────
/** ปุ่มลัดหลังการ์ด/คอนเฟิร์ม: สรุปวันนี้ / สัปดาห์ / เดือน / รายงาน */
export function ledgerQuickReply(): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "📅 วันนี้", text: "สรุปวันนี้" } },
      { type: "action", action: { type: "message", label: "🗓️ สัปดาห์", text: "สรุปสัปดาห์" } },
      { type: "action", action: { type: "message", label: "📆 เดือน", text: "สรุปเดือน" } },
      { type: "action", action: { type: "message", label: "📊 รายงาน", text: "รายงาน" } },
    ],
  };
}

// ── record confirmation ────────────────────────────────────────────────────────
/**
 * คอนเฟิร์มการบันทึกแบบกระชับ เช่น
 *   "✅ บันทึก 2 รายการ: กาแฟ −50 (กิน), เงินเดือน +30,000 (เงินเดือน)"
 * + Quick Reply. `inserted` คือแถวที่เพิ่ง insert (มี category แล้ว).
 */
export function buildRecordConfirm(
  inserted: LedgerRow[],
  _opts?: Record<string, unknown>
): OutboundMessage {
  const parts = inserted.map(
    (r) => `${r.raw_text ?? "(ไม่ระบุ)"} ${signed(r.kind, r.amount)} (${r.category})`
  );
  const text = `✅ บันทึก ${inserted.length} รายการ: ${parts.join(", ")}`;
  return { type: "text", text, quickReply: ledgerQuickReply() };
}

// ── summary flex (the graph card) ──────────────────────────────────────────────
/** หนึ่งแถวยอด: ป้าย (💵 รายรับ) ซ้าย + จำนวนขวา (สี) */
function totalRow(icon: string, label: string, value: string, color: string): Record<string, unknown> {
  return {
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      { type: "text", text: `${icon} ${label}`, size: "sm", color: COLOR_TEXT, flex: 0 },
      { type: "text", text: value, size: "sm", color, weight: "bold", align: "end", flex: 1 },
    ],
  };
}

/** หนึ่งแท่งกราฟหมวด: ป้าย+จำนวนด้านบน แล้วรางเต็มความกว้างที่มีแท่งในสัดส่วน % */
function categoryBar(
  category: string,
  amount: number,
  pct: number,
  color: string
): Record<string, unknown> {
  const width = `${Math.max(Math.round(pct), 3)}%`; // อย่างน้อย 3% ให้มองเห็น
  return {
    type: "box",
    layout: "vertical",
    margin: "md",
    spacing: "xs",
    contents: [
      {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "text",
            text: `${categoryEmoji(category)} ${category}`,
            size: "xs",
            color: COLOR_TEXT,
            flex: 1,
            wrap: false,
          },
          {
            type: "text",
            text: `${formatTHB(amount)} (${Math.round(pct)}%)`,
            size: "xs",
            color: COLOR_MUTED,
            align: "end",
            flex: 0,
          },
        ],
      },
      // ราง (พื้นเทาอ่อน) — กล่องนี้คือ "กราฟ": inner box กว้างตาม %
      {
        type: "box",
        layout: "vertical",
        height: "10px",
        backgroundColor: COLOR_TRACK,
        cornerRadius: "5px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            width,
            height: "10px",
            backgroundColor: color,
            cornerRadius: "5px",
            contents: [{ type: "filler" }],
          },
        ],
      },
    ],
  };
}

/**
 * การ์ดสรุปแบบ Flex ("กราฟ"): header ป้ายช่วง + คงเหลือตัวใหญ่ (เขียว≥0 / แดง<0),
 * body รายรับ/รายจ่าย/คงเหลือ, เส้นคั่น, "รายจ่ายแยกหมวด" + แท่งกราฟ Top ~6 หมวด,
 * footer ปุ่มลิงก์ดูรายงานเว็บ + Quick Reply.
 */
export function buildSummaryFlex(summary: LedgerSummary, opts: SummaryFlexOpts): OutboundMessage {
  const netColor = summary.net >= 0 ? COLOR_GREEN : COLOR_RED;

  const bodyContents: Record<string, unknown>[] = [
    totalRow("💵", "รายรับ", signed("income", summary.income), COLOR_GREEN),
    totalRow("💸", "รายจ่าย", signed("expense", summary.expense), COLOR_RED),
    totalRow("✅", "คงเหลือ", signedNet(summary.net), netColor),
  ];

  const topCats = summary.byCat.slice(0, MAX_BARS);
  if (topCats.length > 0) {
    bodyContents.push({ type: "separator", margin: "lg", color: COLOR_SEP });
    bodyContents.push({
      type: "text",
      text: "รายจ่ายแยกหมวด",
      size: "sm",
      weight: "bold",
      color: COLOR_TEXT,
      margin: "lg",
    });
    topCats.forEach((c, i) => {
      bodyContents.push(categoryBar(c.category, c.amount, c.pct, BAR_COLORS[i % BAR_COLORS.length]));
    });
  } else {
    bodyContents.push({ type: "separator", margin: "lg", color: COLOR_SEP });
    bodyContents.push({
      type: "text",
      text: "ยังไม่มีรายจ่ายในช่วงนี้",
      size: "xs",
      color: COLOR_MUTED,
      margin: "lg",
      align: "center",
    });
  }

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      paddingBottom: "12px",
      contents: [
        { type: "text", text: `📊 ${opts.periodLabel}`, size: "sm", color: COLOR_MUTED },
        { type: "text", text: "คงเหลือ", size: "xs", color: COLOR_MUTED, margin: "md" },
        { type: "text", text: `${signedNet(summary.net)} ฿`, size: "xxl", weight: "bold", color: netColor },
        {
          type: "text",
          text: `${summary.count} รายการ`,
          size: "xxs",
          color: COLOR_MUTED,
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      paddingTop: "8px",
      spacing: "none",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: COLOR_BTN,
          height: "sm",
          action: { type: "uri", label: "📊 ดูรายงานเว็บ", uri: opts.reportUrl },
        },
      ],
    },
    styles: {
      header: { backgroundColor: COLOR_HEADER_BG },
      footer: { backgroundColor: COLOR_FOOTER_BG },
    },
  };

  const altText = `${opts.periodLabel} — รายรับ ${signed("income", summary.income)} · รายจ่าย ${signed(
    "expense",
    summary.expense
  )} · คงเหลือ ${signedNet(summary.net)}`;

  return { type: "flex", altText, contents: bubble, quickReply: ledgerQuickReply() };
}

// ── plain-text fallback ────────────────────────────────────────────────────────
/** สรุปแบบข้อความล้วน: ยอดรวม + บรรทัดหมวด (ใช้เมื่อไม่ต้องการ Flex) */
export function buildSummaryText(summary: LedgerSummary, periodLabel: string): string {
  const lines: string[] = [
    `📊 สรุป${periodLabel}`,
    `💵 รายรับ ${signed("income", summary.income)}`,
    `💸 รายจ่าย ${signed("expense", summary.expense)}`,
    `✅ คงเหลือ ${signedNet(summary.net)}  (${summary.count} รายการ)`,
  ];
  if (summary.byCat.length > 0) {
    lines.push("", "รายจ่ายแยกหมวด:");
    for (const c of summary.byCat) {
      lines.push(`${categoryEmoji(c.category)} ${c.category}  ${formatTHB(c.amount)} (${Math.round(c.pct)}%)`);
    }
  }
  return lines.join("\n");
}
