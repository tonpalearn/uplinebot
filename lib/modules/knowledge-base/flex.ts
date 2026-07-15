import type { OutboundMessage, QuickReplyItem } from "../types";

/**
 * Text builders for the Knowledge Base (คลังความรู้ / FAQ) module.
 *
 * The bot answers with PLAIN LINE TEXT, not a Flex card: the admin writes each answer with its own
 * line breaks and pastes links (LINE auto-links URLs in plain text), so the reply must go out
 * verbatim — no header, no question echo, no decoration. The theme-aware GREEN surface lives on the
 * web page (/km/<token>), not the in-chat reply.
 *
 * buildAnswerText     → the entry's `answer` sent verbatim as a text message (no quickReply).
 * buildNotFoundText   → "ยังไม่มีคำตอบเรื่องนี้ — บันทึกให้แอดมินไปเพิ่มความรู้แล้ว" (explicit-ถาม miss only).
 * buildTaughtConfirm  → concise "✅ จำแล้ว: <question>" confirmation after a "สอน …" teach.
 * kmQuickReply        → the shared "📚 คลังความรู้" chip, used on the manage-link reply.
 */

// ── Quick Reply ──────────────────────────────────────────────────────────────────────────────
/** ปุ่มลัดช่วยเหลือประจำโมดูล — เปิดหน้าคลังความรู้ (แอดมินขอลิงก์ผ่าน "คลังความรู้"). */
export function kmQuickReply(): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "📚 คลังความรู้", text: "คลังความรู้" } },
    ],
  };
}

// ── answer (plain text) ──────────────────────────────────────────────────────────────────────
/**
 * คำตอบของ entry ส่งเป็นข้อความล้วน "ตามที่แอดมินพิมพ์ไว้เป๊ะ ๆ" — ไม่มีหัวข้อ ไม่ echo คำถาม
 * ไม่มีตกแต่ง (แอดมินจัดบรรทัด/วางลิงก์เองแล้ว LINE จะทำลิงก์ให้อัตโนมัติ). ไม่มี Quick Reply.
 */
export function buildAnswerText(entry: { answer: string }): OutboundMessage {
  return { type: "text", text: entry.answer };
}

// ── not-found (plain text) ─────────────────────────────────────────────────────────────────────
/** แจ้งว่ายังไม่มีคำตอบ + บันทึกให้แอดมินไปเพิ่มความรู้ (ใช้เฉพาะตอนถามด้วย "ถาม …" แล้วไม่เจอ). */
export function buildNotFoundText(_question: string): OutboundMessage {
  return { type: "text", text: "ยังไม่มีคำตอบเรื่องนี้ — บันทึกให้แอดมินไปเพิ่มความรู้แล้ว" };
}

// ── teach confirmation (plain text) ────────────────────────────────────────────────────────────
/** คอนเฟิร์มว่าจำความรู้ใหม่แล้ว: "✅ จำแล้ว: <คำถาม>". */
export function buildTaughtConfirm(entry: { question: string }): OutboundMessage {
  return { type: "text", text: `✅ จำแล้ว: ${entry.question}` };
}
