import type { OutboundMessage } from "../types";
import { FS, NEUTRAL, WATCH_ACCENT, gradientHeader, headerStyle, softSep } from "../flex-ui";
import type { WatchSummary } from "./summarize";
import type { WatchConfig } from "./store";
import { splitStored } from "./parse";

/**
 * การ์ดของผู้ช่วยเฝ้ากลุ่ม — โทนคราม (WATCH_ACCENT) แยกจากโมดูลอื่นได้ตั้งแต่ชายตามอง.
 *
 * การ์ดสรุปตั้งใจเรียงตาม "สิ่งที่ต้องทำก่อน": เรื่องด่วน → สิ่งที่ต้องทำ → คำถามค้าง →
 * ประเด็น → ตัวเลข. คนเปิดอ่านสรุปกลุ่มมักอ่านแค่ 3 บรรทัดแรก สิ่งที่รอไม่ได้จึงต้องอยู่บนสุด
 */

/** ชื่อกลุ่มอาจยาวมาก — ตัดให้พอดีหัวการ์ด */
function short(s: string, n = 28): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function bulletBlock(
  title: string,
  items: string[],
  color: string,
  bullet = "•"
): Record<string, unknown>[] {
  if (items.length === 0) return [];
  return [
    {
      type: "text",
      text: title,
      size: FS.section,
      weight: "bold",
      color,
      margin: "lg",
    },
    ...items.map((t) => ({
      type: "text",
      text: `${bullet} ${t}`,
      size: FS.body,
      color: NEUTRAL.text,
      wrap: true,
      margin: "sm",
    })),
  ];
}

export interface SummaryCardOpts {
  groupName: string;
  summary: WatchSummary;
  messageCount: number;
  periodLabel: string;
  /** true = ส่งเพราะเจอคำสำคัญ ไม่ใช่รอบปกติ */
  triggeredBy?: string | null;
  includeNames: boolean;
}

export function buildSummaryCard(o: SummaryCardOpts): OutboundMessage {
  const s = o.summary;
  const body: Record<string, unknown>[] = [];

  if (s.needsAttention) {
    body.push({
      type: "box",
      layout: "vertical",
      backgroundColor: "#FEF2F2",
      cornerRadius: "10px",
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: `🔴 ควรรีบดู — ${s.attentionReason || "มีเรื่องที่รอไม่ได้"}`,
          size: FS.label,
          weight: "bold",
          color: "#B91C1C",
          wrap: true,
        },
      ],
    });
  }

  body.push(
    ...bulletBlock("✅ ต้องทำต่อ", s.actions, "#15803D", "▸"),
    ...bulletBlock("❓ คำถามที่ยังไม่มีคำตอบ", s.openQuestions, "#B45309"),
    ...bulletBlock("💬 คุยเรื่องอะไร", s.topics, NEUTRAL.text),
    ...bulletBlock("📌 ตัวเลข/นัดหมายที่ระบุ", s.facts, NEUTRAL.muted)
  );

  body.push(softSep("lg"));
  body.push({
    type: "text",
    text: o.includeNames
      ? "สรุปนี้ระบุชื่อผู้พูด — พิมพ์ 'ไม่ระบุชื่อ' ในกลุ่มเพื่อปิด"
      : "สรุปเป็นประเด็น ไม่ระบุชื่อผู้พูด",
    size: FS.caption,
    color: NEUTRAL.muted,
    wrap: true,
    margin: "md",
  });

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: WATCH_ACCENT,
      eyebrow: o.triggeredBy ? `🔔 เจอคำสำคัญ: ${short(o.triggeredBy, 20)}` : "🕒 สรุปตามรอบ",
      title: short(o.groupName),
      subtitle: `${o.messageCount} ข้อความ · ${o.periodLabel}`,
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "12px",
      spacing: "none",
      contents: body,
    },
    styles: { header: headerStyle(WATCH_ACCENT) },
  };

  const headline = s.actions[0] ?? s.topics[0] ?? "มีข้อความใหม่";
  return {
    type: "flex",
    altText: `[${short(o.groupName, 18)}] ${short(headline, 60)}`,
    contents: bubble,
  };
}

/** สถานะ — ใครก็ในกลุ่มขอดูได้ ต้องบอกครบว่าเก็บอะไร ส่งให้ใคร เก็บนานแค่ไหน */
export function buildStatusText(
  cfg: WatchConfig | null,
  groupName: string,
  optOutCount: number
): OutboundMessage {
  if (!cfg || !cfg.active) {
    return {
      type: "text",
      text: [
        `🔕 กลุ่มนี้ไม่ได้ถูกสรุป`,
        "",
        "ไม่มีการเก็บข้อความเพื่อทำสรุปในกลุ่มนี้",
        "ถ้าต้องการเปิด พิมพ์: เฝ้ากลุ่มนี้",
      ].join("\n"),
    };
  }

  const dest: string[] = [];
  if (cfg.reportToUser) dest.push("แชทส่วนตัวของผู้เปิดใช้");
  if (cfg.reportToTarget) dest.push("กลุ่มที่กำหนดไว้");
  if (dest.length === 0) dest.push("(ยังไม่ได้ตั้งปลายทาง)");

  const sched =
    cfg.scheduleKind === "interval"
      ? cfg.intervalMinutes >= 60
        ? `ทุก ${Math.round(cfg.intervalMinutes / 60)} ชั่วโมง`
        : `ทุก ${cfg.intervalMinutes} นาที`
      : cfg.scheduleKind === "times"
        ? `เวลา ${cfg.reportTimes ?? "-"}`
        : "เฉพาะเมื่อเจอคำสำคัญ";

  const kw = splitStored(cfg.keywords);
  const urgent = splitStored(cfg.urgentKeywords);

  return {
    type: "text",
    text: [
      `🔍 กลุ่มนี้กำลังถูกสรุปอยู่`,
      "",
      `ส่งสรุปไปที่: ${dest.join(" + ")}`,
      `รอบการส่ง: ${sched}`,
      kw.length ? `คำสำคัญที่เฝ้า: ${kw.join(", ")}` : "คำสำคัญที่เฝ้า: —",
      urgent.length ? `คำที่ถือว่าด่วน: ${urgent.join(", ")}` : "",
      `ระบุชื่อผู้พูดในสรุป: ${cfg.includeNames ? "ระบุ" : "ไม่ระบุ"}`,
      `เก็บข้อความไว้: ${cfg.retentionDays} วัน แล้วลบอัตโนมัติ`,
      optOutCount > 0 ? `มี ${optOutCount} คนขอไม่ให้สรุปข้อความตัวเอง` : "",
      "",
      "ถ้าไม่อยากให้ข้อความของคุณถูกสรุป พิมพ์:",
      "ไม่สรุปข้อความผม",
      "(ข้อความเก่าของคุณจะถูกลบทิ้งด้วย)",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** ประกาศตัวตอนเริ่มเฝ้า — คนในกลุ่มต้องรู้ ไม่ใช่รู้แค่คนสั่ง */
export function buildStartedText(groupName: string): OutboundMessage {
  return {
    type: "text",
    text: [
      "🔍 เริ่มสรุปบทสนทนากลุ่มนี้แล้ว",
      "",
      "แจ้งให้ทุกคนทราบ: บอทจะอ่านข้อความในกลุ่มเพื่อทำสรุปประเด็นส่งให้ผู้เปิดใช้",
      "• สรุปเป็นประเด็น ไม่ระบุชื่อผู้พูด (ค่าเริ่มต้น)",
      "• ไม่เก็บรูป ไฟล์ เสียง — เก็บเฉพาะข้อความตัวอักษร",
      "• ข้อความถูกลบอัตโนมัติภายใน 3 วัน",
      "",
      "พิมพ์ 'เฝ้าอะไรอยู่' เพื่อดูรายละเอียดได้ตลอด",
      "พิมพ์ 'ไม่สรุปข้อความผม' ถ้าไม่ต้องการให้ข้อความของคุณถูกสรุป",
    ].join("\n"),
  };
}

export function buildStoppedText(): OutboundMessage {
  return {
    type: "text",
    text: "🔕 หยุดสรุปกลุ่มนี้แล้ว — ข้อความที่ค้างอยู่จะถูกลบตามกำหนดเดิม",
  };
}

export function buildOptOutText(on: boolean): OutboundMessage {
  return {
    type: "text",
    text: on
      ? "✅ รับทราบ — ข้อความของคุณจะไม่ถูกนำไปสรุป และข้อความเก่าที่เก็บไว้ถูกลบแล้ว\nเปลี่ยนใจพิมพ์: สรุปข้อความผมได้"
      : "✅ รับทราบ — ข้อความของคุณจะถูกนำไปสรุปตามปกติแล้ว",
  };
}

export function buildNoNewsText(groupName: string): OutboundMessage {
  return {
    type: "text",
    text: `[${short(groupName, 20)}] ไม่มีบทสนทนาใหม่ที่ต้องสรุป`,
  };
}

export function buildHelpText(): OutboundMessage {
  return {
    type: "text",
    text: [
      "🔍 ผู้ช่วยเฝ้ากลุ่ม — พิมพ์ในกลุ่มที่ต้องการ",
      "",
      "เปิด/ปิด:",
      "• เฝ้ากลุ่มนี้ — เริ่มสรุป",
      "• เลิกเฝ้า — หยุด",
      "• สรุปตอนนี้ — ขอสรุปเดี๋ยวนี้",
      "",
      "รอบการส่ง:",
      "• ทุก 30 นาที / ทุก 4 ชม. (15 นาที – 24 ชม.)",
      "• รายงานเวลา 09:00, 18:00",
      "",
      "คำสำคัญ:",
      "• คำสำคัญ ราคา, ยกเลิก, ด่วน — เจอแล้วเด้งทันที",
      "• คำเตือน ไม่พอใจ, ร้องเรียน — เด้งพร้อมป้ายแดง",
      "",
      "ปลายทาง & ความเป็นส่วนตัว:",
      "• ส่งสรุปให้ผม / ส่งสรุปที่นี่",
      "• ระบุชื่อ / ไม่ระบุชื่อ (ค่าเริ่มต้น: ไม่ระบุ)",
      "• เฝ้าอะไรอยู่ — ดูว่ากำลังเก็บอะไร ส่งให้ใคร",
      "• ไม่สรุปข้อความผม — ขอไม่ถูกสรุป (ใครก็ใช้ได้)",
    ].join("\n"),
  };
}
