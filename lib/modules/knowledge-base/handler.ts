import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage } from "../types";
import { parseKmIntent } from "./parse";
import { addEntry, searchKb, logUnanswered } from "./store";
import { buildAnswerFlex, buildNotFoundFlex, buildTaughtConfirm, kmQuickReply } from "./flex";
import { getOrCreateKmToken, kmManageUrl } from "../../km-token";

/**
 * Knowledge Base / FAQ — บอทตอบคำถามจากคลังความรู้ต่อ tenant (module_key: faq_rag_support).
 * Per SYSTEM-DESIGN.md §4.2 (ModuleHandler). Phase 1: retrieval แบบ self-hosted (pg_trgm) ไม่มี
 * paid API. ตอบด้วยการ์ด Flex สีเขียว (KM accent).
 *
 * intent (parseKmIntent):
 *   - teach : "สอน <คำถาม> = <คำตอบ>" → บันทึกความรู้ (source='chat') แล้วคอนเฟิร์ม
 *   - link  : "คลังความรู้" | "จัดการความรู้" | "km" → ส่งลิงก์หน้าจัดการ /km/<token>
 *   - ask   : "ถาม <คำถาม>" → ค้นคลัง → เจอ = การ์ดคำตอบ, ไม่เจอ = บันทึกคิว + การ์ด "ยังไม่มีคำตอบ"
 *
 * answer_all (config, ต่อ target): ถ้าตั้ง true บอทจะถือ "ทุกข้อความ" เป็นคำถาม (บอทซัพพอร์ต
 * เฉพาะทาง) — เป็นเหตุผลที่โมดูลนี้อยู่ท้ายสุดของ ROUTER_PRIORITY: มันจะเห็นเฉพาะข้อความที่ไม่มี
 * โมดูลอื่นรับไปก่อน จึงไม่กลืนคำสั่งของ todo/expense/slip ฯลฯ.
 */
export const KnowledgeBaseModule: ModuleHandler = {
  key: "faq_rag_support",

  matchesIntent(event: LineEvent, config: ModuleConfig): boolean {
    if (event.type !== "message" || event.message?.type !== "text") return false;
    // answer_all → รับทุกข้อความเป็นคำถาม; ไม่งั้นรับเฉพาะ teach/link/ask ("สอน"/"คลังความรู้"/"ถาม")
    if (config.answer_all === true) return true;
    return parseKmIntent(event.message.text ?? "") !== null;
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const text = event.message?.text ?? "";
    const intent = parseKmIntent(text);

    // สอนความรู้ใหม่ (บันทึกในแชท)
    if (intent?.action === "teach") {
      const entry = await addEntry(ctx.tenantId, {
        question: intent.question,
        answer: intent.answer,
        source: "chat",
      });
      return [buildTaughtConfirm(entry)];
    }

    // ขอลิงก์หน้าจัดการคลังความรู้ (ระดับ tenant)
    if (intent?.action === "link") {
      const token = await getOrCreateKmToken(ctx.tenantId);
      const url = kmManageUrl(token);
      return [
        {
          type: "text",
          text: `📚 คลังความรู้ของธุรกิจนี้:\n${url}\n\nเปิดลิงก์เพื่อเพิ่ม/แก้คำถาม-คำตอบ · วางเอกสารให้ระบบแตกเป็นความรู้ · และดูคำถามที่ตอบไม่ได้ (ลิงก์นี้จัดการได้ทั้งคลัง — แชร์เฉพาะแอดมิน)`,
          quickReply: kmQuickReply(),
        },
      ];
    }

    // ถามคำถาม — จาก "ถาม ..." หรือ (answer_all) ถือทั้งข้อความเป็นคำถาม
    const question = intent?.action === "ask" ? intent.question : text.trim();
    if (!question) return [];

    const hits = await searchKb(ctx.tenantId, question);
    if (hits.length > 0) {
      const [best, ...related] = hits;
      return [buildAnswerFlex(best, { related })];
    }

    // ไม่พบคำตอบ → เข้าคิวให้แอดมิน + ตอบการ์ด "ยังไม่มีคำตอบ" (ไม่ส่งลิงก์จัดการให้ผู้ใช้ทั่วไป)
    await logUnanswered(ctx.tenantId, question, ctx.targetId);
    return [buildNotFoundFlex(question)];
  },
};
