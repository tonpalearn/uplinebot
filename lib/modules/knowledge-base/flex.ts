import type { OutboundMessage, QuickReplyItem } from "../types";
import type { KmSearchHit } from "./store";
import {
  FS,
  NEUTRAL,
  KM_ACCENT,
  gradientHeader,
  headerStyle,
  footerStyle,
  softSep,
  primaryButton,
} from "../flex-ui";

/**
 * Flex + text builders for the Knowledge Base (คลังความรู้ / FAQ) module.
 *
 * Cards wear the shared design system (lib/modules/flex-ui.ts) in the KM accent — a GREEN
 * (leaf) gradient header — so a Q&A answer reads distinct from the todo (red) and money
 * (emerald) cards while sharing the SAME compact type scale (FS). Flex colors are FIXED hex
 * (LINE renders server-side); the theme-aware surface is the web page (/km/<token>).
 *
 * buildAnswerFlex     → GREEN card: matched question in the header, the answer in the body,
 *                       source in the footer; near-matches become "ถามต่อ" Quick Reply chips.
 * buildNotFoundFlex   → friendly "ยังไม่มีคำตอบ — บันทึกให้แอดมินแล้ว" card (+ optional manage link).
 * buildTaughtConfirm  → concise "✅ จำแล้ว: <question>" text + Quick Reply.
 * kmQuickReply        → the shared helpful chip(s) (📚 คลังความรู้).
 */

/** ความรู้เท่าที่การ์ดต้องใช้ (KmEntry หรือ KmSearchHit ก็ผ่าน). */
interface AnswerLike {
  question: string;
  answer: string;
  source?: string;
}

/** อธิบายที่มาของความรู้ให้อ่านง่าย. */
function sourceLabel(source?: string): string {
  const s = (source ?? "").trim();
  if (!s || s === "manual") return "เพิ่มโดยแอดมิน";
  if (s === "chat") return "สอนในแชท";
  return s; // ชื่อเอกสาร
}

/** ตัดข้อความให้สั้นลงพร้อม … (ใช้กับ label ปุ่ม/altText). */
function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// ── Quick Reply ──────────────────────────────────────────────────────────────────────────────
/** ปุ่มลัดช่วยเหลือประจำโมดูล — เปิดหน้าคลังความรู้ (แอดมินขอลิงก์ผ่าน "คลังความรู้"). */
export function kmQuickReply(): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "📚 คลังความรู้", text: "คลังความรู้" } },
    ],
  };
}

/** รวมปุ่ม "ถามต่อ" จากรายการใกล้เคียง + ปุ่มประจำโมดูล (จำกัดไม่เกิน 13 ปุ่มตามลิมิต LINE). */
function answerQuickReply(related?: KmSearchHit[]): { items: QuickReplyItem[] } {
  const relatedChips: QuickReplyItem[] = (related ?? []).map((r) => ({
    type: "action",
    action: { type: "message", label: truncate(`❓ ${r.question}`, 20), text: `ถาม ${r.question}` },
  }));
  const items = [...relatedChips, ...kmQuickReply().items].slice(0, 13);
  return { items };
}

// ── answer card ────────────────────────────────────────────────────────────────────────────────
export interface AnswerFlexOpts {
  /** รายการที่ใกล้เคียงอื่น ๆ (นอกเหนือจากตัวที่ตอบ) → กลายเป็นปุ่ม "ถามต่อ". */
  related?: KmSearchHit[];
}

/**
 * การ์ดคำตอบ (GREEN): header = คำถามที่แมตช์, body = คำตอบ (wrap), footer = ที่มา.
 * รายการใกล้เคียงจาก opts.related → ปุ่ม Quick Reply "ถามต่อ".
 */
export function buildAnswerFlex(entry: AnswerLike, opts?: AnswerFlexOpts): OutboundMessage {
  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: KM_ACCENT,
      eyebrow: "📚 คลังความรู้",
      title: entry.question,
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "16px",
      spacing: "none",
      contents: [
        {
          type: "text",
          text: entry.answer,
          size: FS.body,
          color: NEUTRAL.text,
          wrap: true,
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      paddingTop: "12px",
      spacing: "none",
      contents: [
        { type: "text", text: `ที่มา: ${sourceLabel(entry.source)}`, size: FS.meta, color: NEUTRAL.muted },
      ],
    },
    styles: {
      header: headerStyle(KM_ACCENT),
      footer: footerStyle(),
    },
  };

  const altText = truncate(`${entry.question} — ${entry.answer}`, 200);
  return { type: "flex", altText, contents: bubble, quickReply: answerQuickReply(opts?.related) };
}

// ── not-found card ──────────────────────────────────────────────────────────────────────────────
export interface NotFoundFlexOpts {
  /** ลิงก์หน้าจัดการ (แสดงปุ่มเปิดคลังความรู้) — ปกติส่งเฉพาะกรณีแอดมิน. */
  manageUrl?: string;
}

/**
 * การ์ด "ยังไม่มีคำตอบ" (GREEN): แจ้งว่าบันทึกคำถามให้แอดมินไปเพิ่มความรู้แล้ว. ถ้ามี manageUrl
 * ใส่ปุ่มเปิดคลังความรู้ (handler จะไม่ส่ง URL นี้ให้ผู้ใช้ทั่วไปในกลุ่ม — เป็นลิงก์ระดับ tenant).
 */
export function buildNotFoundFlex(question: string, opts?: NotFoundFlexOpts): OutboundMessage {
  const bodyContents: Record<string, unknown>[] = [
    {
      type: "text",
      text: "ยังไม่มีคำตอบเรื่องนี้ — บันทึกให้แอดมินไปเพิ่มความรู้แล้ว 🙏",
      size: FS.body,
      color: NEUTRAL.text,
      wrap: true,
    },
  ];
  const q = question.trim();
  if (q) {
    bodyContents.push(softSep("md"));
    bodyContents.push({
      type: "text",
      text: `คำถาม: ${q}`,
      size: FS.meta,
      color: NEUTRAL.muted,
      margin: "md",
      wrap: true,
    });
  }

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: KM_ACCENT,
      eyebrow: "📚 คลังความรู้",
      title: "ยังไม่มีคำตอบเรื่องนี้",
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "16px",
      spacing: "none",
      contents: bodyContents,
    },
    styles: { header: headerStyle(KM_ACCENT) },
  };

  if (opts?.manageUrl) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "sm",
      contents: [primaryButton("📚 เปิดคลังความรู้", opts.manageUrl, KM_ACCENT.solid)],
    };
    (bubble.styles as Record<string, unknown>).footer = footerStyle();
  }

  return {
    type: "flex",
    altText: "ยังไม่มีคำตอบเรื่องนี้ — บันทึกให้แอดมินแล้ว",
    contents: bubble,
    quickReply: kmQuickReply(),
  };
}

// ── teach confirmation ──────────────────────────────────────────────────────────────────────────
/** คอนเฟิร์มว่าจำความรู้ใหม่แล้ว: "✅ จำแล้ว: <คำถาม>" + Quick Reply. */
export function buildTaughtConfirm(entry: AnswerLike): OutboundMessage {
  return {
    type: "text",
    text: `✅ จำแล้ว: ${entry.question}`,
    quickReply: kmQuickReply(),
  };
}
