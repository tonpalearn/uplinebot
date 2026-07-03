import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage } from "../types";
import { parseLedgerIntent } from "./parse";
import { addEntries, getEntries, deleteLast } from "./ledger";
import { aggregate, periodRange } from "./summary";
import { buildRecordConfirm, buildSummaryFlex, buildEntryListFlex, ledgerQuickReply } from "./flex";
import { getOrCreateLedgerToken, ledgerReportUrl } from "../../ledger-token";

/**
 * Expense Tracker — บันทึกรายรับ-รายจ่าย (module_key: expense_tracker).
 * Per SYSTEM-DESIGN.md §4.2 (ModuleHandler interface). Modeled on the "EunJod" bot.
 *
 * A LINE chat/group = ONE ledger — everything is scoped to ctx.targetId (exactly like the
 * Assistant's todos are target-scoped). Categorization is 100% rule-based (no LLM).
 *
 * UX (parseLedgerIntent decides which):
 *   - record  : พิมพ์รายการ (มีจำนวนเงิน) เช่น "กาแฟ 50" / "+เงินเดือน 30000" / หลายบรรทัด/คั่น ,
 *   - summary : "สรุปวันนี้" / "สัปดาห์" / "เดือน" → การ์ดกราฟ Flex
 *   - list    : "รายการ" / "ลิสต์" / "list"        → การ์ดลิสต์รายการวันนี้ (เรียบง่าย ไม่มีกราฟ)
 *   - report  : "รายงาน" / "report" / "กราฟ"      → ลิงก์หน้าเว็บ /ledger/<token>
 *   - undo    : "ยกเลิก" / "ลบล่าสุด" / "undo"      → soft-delete รายการล่าสุด
 * ข้อความอื่นที่ไม่มีจำนวนเงิน → ไม่แมตช์ (บอทเงียบ ไม่จดขยะ). "ลบ" เดี่ยวเป็นของโมดูล todo.
 */

export const ExpenseTrackerModule: ModuleHandler = {
  key: "expense_tracker",

  matchesIntent(event: LineEvent, _config: ModuleConfig): boolean {
    if (event.type !== "message" || event.message?.type !== "text") return false;
    return parseLedgerIntent(event.message.text ?? "", new Date()) !== null;
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const text = event.message?.text ?? "";
    const now = new Date();
    const intent = parseLedgerIntent(text, now);
    if (!intent) return [];

    switch (intent.action) {
      case "record": {
        const inserted = await addEntries(ctx.targetId, intent.entries);
        if (inserted.length === 0) return [];
        return [buildRecordConfirm(inserted)];
      }

      case "summary": {
        const { from, to, label } = periodRange(intent.period, now);
        const rows = await getEntries(ctx.targetId, from, to);
        const summary = aggregate(rows);
        const token = await getOrCreateLedgerToken(ctx.targetId);
        const reportUrl = ledgerReportUrl(token);
        return [buildSummaryFlex(summary, { periodLabel: label, reportUrl, quick: true })];
      }

      case "list": {
        // รายการวันนี้แบบเรียบง่าย (ไม่มีกราฟ) — โหลดช่วง "วันนี้" แล้วคืนการ์ดลิสต์
        const { from, to, label } = periodRange("day", now);
        const rows = await getEntries(ctx.targetId, from, to);
        return [buildEntryListFlex(rows, { periodLabel: label })];
      }

      case "report": {
        const token = await getOrCreateLedgerToken(ctx.targetId);
        const url = ledgerReportUrl(token);
        return [
          {
            type: "text",
            text: `📊 รายงานรายรับ-รายจ่ายของแชทนี้:\n${url}\n\nเปิดลิงก์เพื่อดูสรุป กราฟแยกหมวด และรายการทั้งหมด (ลิงก์นี้เฉพาะกลุ่ม/แชทนี้เท่านั้น)`,
            quickReply: ledgerQuickReply(),
          },
        ];
      }

      case "undo": {
        const removed = await deleteLast(ctx.targetId);
        if (!removed) {
          return [
            {
              type: "text",
              text: "ไม่มีรายการให้ยกเลิก",
              quickReply: ledgerQuickReply(),
            },
          ];
        }
        const sign = removed.kind === "income" ? "+" : "−";
        const amountStr = removed.amount.toLocaleString("th-TH");
        return [
          {
            type: "text",
            text: `↩️ ยกเลิกแล้ว: ${removed.raw_text ?? "(ไม่ระบุ)"} ${sign}${amountStr} (${removed.category})`,
            quickReply: ledgerQuickReply(),
          },
        ];
      }
    }
  },
};
