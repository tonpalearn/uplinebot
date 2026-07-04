import type { OutboundMessage, QuickReplyItem } from "../types";
import { categoryEmoji } from "./categories";
import type { LedgerSummary } from "./summary";
import type { LedgerRow } from "./ledger";
import {
  FS,
  NEUTRAL,
  MONEY,
  MONEY_ACCENT,
  BAR_COLORS,
  gradientHeader,
  headerStyle,
  footerStyle,
  numberChip,
  softSep,
  primaryButton,
} from "../flex-ui";

/**
 * Flex + plain-text builders for the expense-tracker (สมุดรายรับ-รายจ่าย).
 *
 * The cards wear the shared design system (lib/modules/flex-ui.ts) in the MONEY accent —
 * a GREEN gradient header + emerald number chips — the counterpart to the RED todo card.
 * Money DIRECTION stays semantic regardless of the green header: รายรับ green (+), รายจ่าย
 * red (−). Flex colors are FIXED hex (LINE renders server-side); the theme-aware surface is
 * the web report (/ledger/<token>).
 *
 * buildRecordConfirm  → concise "✅ บันทึก N รายการ: …" text + Quick Reply.
 * buildSummaryFlex    → the polished "graph card": green header with the net balance, then
 *                       income/expense/net rows + per-category HORIZONTAL BARS + web button.
 * buildEntryListFlex  → a clean NUMBERED list card (chip + item + category + signed amount) —
 *                       the simple "รายการ" view (no graph). Empty → friendly hint text.
 * buildSummaryText    → plain-text fallback (totals + category lines).
 */

/** จำนวนหมวดสูงสุดที่โชว์เป็นแท่งกราฟในการ์ด */
const MAX_BARS = 6;

export interface SummaryFlexOpts {
  periodLabel: string;
  reportUrl: string;
  /** true = มาจาก Quick Reply/สรุปแบบเร็ว (สงวนไว้ปรับ heading ในอนาคต) */
  quick?: boolean;
}

// ── money formatting ─────────────────────────────────────────────────────────────────
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

// ── Quick Reply ──────────────────────────────────────────────────────────────────────
/** ปุ่มลัดหลังการ์ด/คอนเฟิร์ม: สรุปวันนี้ / สัปดาห์ / เดือน / รายการ / รายงาน */
export function ledgerQuickReply(): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "📅 วันนี้", text: "สรุปวันนี้" } },
      { type: "action", action: { type: "message", label: "🗓️ สัปดาห์", text: "สรุปสัปดาห์" } },
      { type: "action", action: { type: "message", label: "📆 เดือน", text: "สรุปเดือน" } },
      { type: "action", action: { type: "message", label: "📋 รายการ", text: "รายการ" } },
      { type: "action", action: { type: "message", label: "📊 รายงาน", text: "รายงาน" } },
    ],
  };
}

// ── record confirmation ────────────────────────────────────────────────────────────────
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

// ── entry list flex (the simple list card) ──────────────────────────────────────────────
export interface EntryListFlexOpts {
  periodLabel: string;
}

/** หนึ่งแถวรายการในลิสต์: เลขในชิป + อีโมจิ/ชื่อรายการ + หมวด (ซ้าย) แล้วจำนวนมีสี (ขวา) */
function entryRow(index: number, row: LedgerRow): Record<string, unknown> {
  const amtColor = row.kind === "income" ? MONEY.income : MONEY.expense;
  return {
    type: "box",
    layout: "horizontal",
    margin: "md",
    spacing: "md",
    contents: [
      numberChip(index, MONEY_ACCENT),
      {
        type: "box",
        layout: "vertical",
        flex: 1,
        justifyContent: "center",
        spacing: "none",
        contents: [
          {
            type: "text",
            text: `${categoryEmoji(row.category)} ${row.raw_text ?? "(ไม่ระบุ)"}`,
            size: FS.body,
            color: NEUTRAL.text,
            weight: "bold",
            wrap: true,
          },
          { type: "text", text: row.category, size: FS.meta, color: NEUTRAL.muted, margin: "xs" },
        ],
      },
      {
        type: "text",
        text: signed(row.kind, row.amount),
        size: FS.body,
        color: amtColor,
        weight: "bold",
        align: "end",
        gravity: "center",
        flex: 0,
      },
    ],
  };
}

/**
 * การ์ดลิสต์รายการแบบเรียบง่าย (ไม่มีกราฟ) — ใช้กับคำสั่ง "รายการ"/"ลิสต์".
 * header เขียว (ป้ายช่วง + จำนวนรายการ), body รายการมีชิปเลข (อีโมจิ+ชื่อ, หมวด, จำนวนมีสี).
 * ว่าง → คืนข้อความชวนบันทึกแทน (ไม่ขึ้นการ์ดเปล่า).
 */
export function buildEntryListFlex(entries: LedgerRow[], opts: EntryListFlexOpts): OutboundMessage {
  if (entries.length === 0) {
    return {
      type: "text",
      text: "ยังไม่มีรายการวันนี้ — พิมพ์ \"จด\" แล้วตามด้วยรายการ เช่น จด กาแฟ 50",
      quickReply: ledgerQuickReply(),
    };
  }

  const bodyContents: Record<string, unknown>[] = entries.map((r, i) => entryRow(i + 1, r));

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: MONEY_ACCENT,
      title: `📋 รายการ ${opts.periodLabel}`,
      subtitle: `${entries.length} รายการ`,
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "12px",
      spacing: "none",
      contents: bodyContents,
    },
    styles: {
      header: headerStyle(MONEY_ACCENT),
    },
  };

  const altText = `รายการ ${opts.periodLabel} — ${entries.length} รายการ`;
  return { type: "flex", altText, contents: bubble, quickReply: ledgerQuickReply() };
}

// ── summary flex (the graph card) ────────────────────────────────────────────────────────
/** หนึ่งแถวยอด: ป้าย (💵 รายรับ) ซ้าย + จำนวนขวา (สี) */
function totalRow(icon: string, label: string, value: string, color: string): Record<string, unknown> {
  return {
    type: "box",
    layout: "horizontal",
    margin: "md",
    contents: [
      { type: "text", text: `${icon} ${label}`, size: FS.label, color: NEUTRAL.text, flex: 0 },
      { type: "text", text: value, size: FS.label, color, weight: "bold", align: "end", flex: 1 },
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
            size: FS.meta,
            color: NEUTRAL.text,
            flex: 1,
            wrap: false,
          },
          {
            type: "text",
            text: `${formatTHB(amount)} (${Math.round(pct)}%)`,
            size: FS.caption,
            color: NEUTRAL.muted,
            align: "end",
            flex: 0,
          },
        ],
      },
      // ราง (พื้นเทาอ่อน) — กล่องนี้คือ "กราฟ": inner box กว้างตาม %
      {
        type: "box",
        layout: "vertical",
        height: "12px",
        backgroundColor: NEUTRAL.track,
        cornerRadius: "6px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            width,
            height: "12px",
            backgroundColor: color,
            cornerRadius: "6px",
            contents: [{ type: "filler" }],
          },
        ],
      },
    ],
  };
}

/**
 * การ์ดสรุปแบบ Flex ("กราฟ"): header เขียว (ป้ายช่วง + คงเหลือตัวใหญ่สีขาว, เซ็นต์ +/−),
 * body รายรับ/รายจ่าย/คงเหลือ (คงเหลือมีสีตามเครื่องหมาย), เส้นคั่น, "รายจ่ายแยกหมวด" +
 * แท่งกราฟ Top ~6 หมวด, footer ปุ่มลิงก์ดูรายงานเว็บ + Quick Reply.
 */
export function buildSummaryFlex(summary: LedgerSummary, opts: SummaryFlexOpts): OutboundMessage {
  const netColor = summary.net >= 0 ? MONEY.income : MONEY.expense;

  const bodyContents: Record<string, unknown>[] = [
    totalRow("💵", "รายรับ", signed("income", summary.income), MONEY.income),
    totalRow("💸", "รายจ่าย", signed("expense", summary.expense), MONEY.expense),
    totalRow("✅", "คงเหลือ", signedNet(summary.net), netColor),
  ];

  const topCats = summary.byCat.slice(0, MAX_BARS);
  if (topCats.length > 0) {
    bodyContents.push(softSep("lg"));
    bodyContents.push({
      type: "text",
      text: "รายจ่ายแยกหมวด",
      size: FS.section,
      weight: "bold",
      color: NEUTRAL.text,
      margin: "lg",
    });
    topCats.forEach((c, i) => {
      bodyContents.push(categoryBar(c.category, c.amount, c.pct, BAR_COLORS[i % BAR_COLORS.length]));
    });
  } else {
    bodyContents.push(softSep("lg"));
    bodyContents.push({
      type: "text",
      text: "ยังไม่มีรายจ่ายในช่วงนี้",
      size: FS.meta,
      color: NEUTRAL.muted,
      margin: "lg",
      align: "center",
    });
  }

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: MONEY_ACCENT,
      eyebrow: `📊 ${opts.periodLabel}`,
      heroLabel: "คงเหลือ",
      hero: `${signedNet(summary.net)} ฿`,
      subtitle: `${summary.count} รายการ`,
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "12px",
      spacing: "none",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "sm",
      contents: [primaryButton("📊 ดูรายงานเว็บ", opts.reportUrl, MONEY_ACCENT.solid)],
    },
    styles: {
      header: headerStyle(MONEY_ACCENT),
      footer: footerStyle(),
    },
  };

  const altText = `${opts.periodLabel} — รายรับ ${signed("income", summary.income)} · รายจ่าย ${signed(
    "expense",
    summary.expense
  )} · คงเหลือ ${signedNet(summary.net)}`;

  return { type: "flex", altText, contents: bubble, quickReply: ledgerQuickReply() };
}

// ── plain-text fallback ──────────────────────────────────────────────────────────────────
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
