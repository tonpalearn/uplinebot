import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage } from "../types";
import { parseKmIntent } from "./parse";
import { addEntry, searchKb, logUnanswered, matchExactTrigger } from "./store";
import { buildAnswerText, buildNotFoundText, buildTaughtConfirm, kmQuickReply } from "./flex";
import { getOrCreateKmToken, kmManageUrl } from "../../km-token";
import { getServiceClient } from "../../db";

/**
 * Knowledge Base / FAQ — บอทตอบคำถามจากคลังความรู้ต่อ tenant (module_key: faq_rag_support).
 * Per SYSTEM-DESIGN.md §4.2 (ModuleHandler). Phase 1: retrieval แบบ self-hosted (pg_trgm) ไม่มี
 * paid API. ตอบเป็นข้อความล้วน (ไม่ใช่การ์ด Flex) — แอดมินจัดบรรทัด/วางลิงก์เองแล้ว LINE ทำลิงก์ให้.
 *
 * intent (parseKmIntent):
 *   - teach : "สอน <คำถาม> = <คำตอบ>" → บันทึกความรู้ (source='chat') แล้วคอนเฟิร์ม
 *   - link  : "คลังความรู้" | "จัดการความรู้" | "km" → ส่งลิงก์หน้าจัดการ /km/<token>
 *   - ask   : "ถาม <คำถาม>" → ค้นคลัง (fuzzy) → เจอ = ข้อความคำตอบ, ไม่เจอ = บันทึกคิว + "ยังไม่มีคำตอบ"
 *
 * exact_trigger (config, default ON): ถ้าข้อความที่พิมพ์ "ตรงเป๊ะ" กับ trigger keyword ของ entry ใด
 * (เช่นพิมพ์ opb2026 เฉย ๆ) บอทตอบ entry นั้นทันทีโดยไม่ต้องมี "ถาม". ข้อความอื่นที่ไม่ตรง → เงียบ
 * (ไม่มีการ์ด ไม่มี "ไม่พบ") เพื่อให้แอดมินคุยในกลุ่มได้ตามปกติ.
 *
 * answer_all (config): ถ้าตั้ง true บอทจะถือ "ทุกข้อความ" เป็นคำถาม (บอทซัพพอร์ตเฉพาะทาง) — เป็นเหตุผล
 * ที่โมดูลนี้อยู่ท้ายสุดของ ROUTER_PRIORITY: มันเห็นเฉพาะข้อความที่ไม่มีโมดูลอื่นรับไปก่อน จึงไม่กลืน
 * คำสั่งของ todo/expense/slip ฯลฯ.
 */

/**
 * matchesIntent() รับ config ของ target มาแล้ว แต่ handleEvent() ได้แค่ (event, ctx) ตามสัญญา
 * ModuleHandler — handleEvent จึงโหลด config เดิมซ้ำเองด้วย ctx.targetId (แพตเทิร์นเดียวกับ broadcast)
 * เพื่อให้โมดูลนี้ implement interface กลาง (lib/modules/types.ts) แบบ self-contained.
 */
async function loadModuleConfig(targetId: string): Promise<ModuleConfig> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_module_configs")
    .select("settings")
    .eq("target_id", targetId)
    .eq("module_key", "faq_rag_support")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load faq_rag_support config for target "${targetId}": ${error.message}`);
  }

  return (data?.settings as ModuleConfig) ?? {};
}

export const KnowledgeBaseModule: ModuleHandler = {
  key: "faq_rag_support",

  matchesIntent(event: LineEvent, config: ModuleConfig): boolean {
    if (event.type !== "message" || event.message?.type !== "text") return false;
    // exact_trigger defaults ON → รับข้อความทุกอันเพื่อ "ได้ลองเช็ค trigger" ใน handleEvent
    // (handleEvent จะเงียบเองถ้าไม่ตรง trigger และไม่ใช่ ถาม/answer_all). teach/link/ask และ
    // answer_all ก็ยังทำให้แมตช์เช่นเดิม แม้ปิด exact_trigger.
    return (
      parseKmIntent(event.message.text ?? "") !== null ||
      config.answer_all === true ||
      config.exact_trigger !== false
    );
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const text = event.message?.text ?? "";
    const intent = parseKmIntent(text);

    // 1a) สอนความรู้ใหม่ (บันทึกในแชท) → คอนเฟิร์มเป็นข้อความล้วน
    if (intent?.action === "teach") {
      const entry = await addEntry(ctx.tenantId, {
        question: intent.question,
        answer: intent.answer,
        source: "chat",
      });
      return [buildTaughtConfirm(entry)];
    }

    // 1b) ขอลิงก์หน้าจัดการคลังความรู้ (ระดับ tenant)
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

    // 2) ข้อความว่าง → เงียบ
    const raw = (text ?? "").trim();
    if (!raw) return [];

    // 3) trigger ตรงเป๊ะ (ไม่ต้องมี "ถาม") → ตอบ entry นั้นทันทีเป็นข้อความล้วน
    const hit = await matchExactTrigger(ctx.tenantId, raw);
    if (hit) return [buildAnswerText(hit)];

    // 4) ถามชัดเจนด้วย "ถาม …" หรือ answer_all → ค้นคลังแบบ fuzzy
    //    (โหลด config เฉพาะเมื่อไม่ใช่ "ถาม" เพื่อเลี่ยงอ่าน DB ซ้ำบนเส้นทางถามตรง)
    const config: ModuleConfig = intent?.action === "ask" ? {} : await loadModuleConfig(ctx.targetId);
    if (intent?.action === "ask" || config.answer_all === true) {
      const question = intent?.action === "ask" ? intent.question : raw;
      if (!question) return [];

      const hits = await searchKb(ctx.tenantId, question);
      if (hits.length > 0) return [buildAnswerText(hits[0])];

      // ไม่พบคำตอบ → เข้าคิวให้แอดมิน + ตอบ "ยังไม่มีคำตอบ" (เฉพาะกรณีถามตรง/answer_all)
      await logUnanswered(ctx.tenantId, question, ctx.targetId);
      return [buildNotFoundText(question)];
    }

    // 5) ข้อความทั่วไป (ไม่ใช่ trigger, ไม่ใช่ ถาม, ไม่ได้เปิด answer_all) → เงียบ ให้คนคุยกันเองได้
    return [];
  },
};
