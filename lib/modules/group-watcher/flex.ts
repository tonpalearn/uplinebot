import type { OutboundMessage } from "../types";
import { FS, NEUTRAL, WATCH_ACCENT, gradientHeader, headerStyle, softSep } from "../flex-ui";
import type { WatchSummary } from "./summarize";
import type { WatchConfig } from "./store";
import { splitStored } from "./parse";
import { describeSchedule, intervalLabel } from "./schedule";

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


// ── รอบรายงาน ────────────────────────────────────────────────────────────────
/**
 * ตัวเลือกรอบที่ "กดได้" — ปุ่มแบบ message ส่งข้อความเดิมที่ parser รับอยู่แล้ว
 * จึงไม่ต้องมี postback handler แยก และคนที่ชอบพิมพ์เองก็ยังพิมพ์ได้เหมือนเดิม
 *
 * ที่ต้องมีปุ่ม เพราะของเดิมมีแต่คำสั่งพิมพ์ล้วน — คนเปิดใช้แล้วไม่มีทางรู้เลยว่าตั้งรอบได้
 */
const PRESETS: { label: string; cmd: string }[] = [
  { label: "ทุก 1 ชม.", cmd: "ทุก 1 ชม." },
  { label: "ทุก 4 ชม.", cmd: "ทุก 4 ชม." },
  { label: "เช้า-เย็น 09:00 · 18:00", cmd: "เวลา 09:00, 18:00" },
  { label: "วันละครั้ง 18:00", cmd: "เวลา 18:00" },
];

function presetRow(p: { label: string; cmd: string }, active: boolean): Record<string, unknown> {
  return {
    type: "box",
    layout: "horizontal",
    action: { type: "message", label: p.label, text: p.cmd },
    backgroundColor: active ? WATCH_ACCENT.chipBg : "#F8FAFC",
    cornerRadius: "10px",
    paddingAll: "12px",
    margin: "sm",
    contents: [
      {
        type: "text",
        text: (active ? "◉  " : "○  ") + p.label,
        size: FS.body,
        color: active ? WATCH_ACCENT.chipText : NEUTRAL.text,
        weight: active ? "bold" : "regular",
        flex: 1,
        wrap: true,
      },
    ],
  };
}

/** ตอนนี้ตั้งไว้ตรงกับ preset ไหน (ไว้ทำเครื่องหมาย ◉) */
function activeCmd(cfg: WatchConfig): string | null {
  // preset เขียนย่อว่า "ชม." ส่วน label เต็มใช้ "ชั่วโมง" — เทียบกันได้ต้องปรับให้ตรงรูปแบบเดียว
  if (cfg.scheduleKind === "interval") return intervalLabel(cfg.intervalMinutes).replace(" ชั่วโมง", " ชม.");
  if (cfg.scheduleKind === "times") {
    const t = splitStored(cfg.reportTimes);
    return t.length ? `เวลา ${t.join(", ")}` : null;
  }
  return null;
}

export interface ScheduleCardOpts {
  cfg: WatchConfig;
  groupName: string;
  /** "14:30 น. (อีก 2 ชม.)" — null ถ้าไม่สรุปตามเวลา */
  nextLabel: string | null;
  /** true = เพิ่งเปิดเฝ้า (การ์ดนี้ทำหน้าที่ประกาศตัวให้คนในกลุ่มด้วย) */
  justStarted?: boolean;
}

export function buildScheduleCard(o: ScheduleCardOpts): OutboundMessage {
  const active = activeCmd(o.cfg);
  const body: Record<string, unknown>[] = [
    {
      type: "box",
      layout: "vertical",
      backgroundColor: WATCH_ACCENT.chipBg,
      cornerRadius: "10px",
      paddingAll: "14px",
      contents: [
        { type: "text", text: "รอบรายงานตอนนี้", size: FS.caption, color: WATCH_ACCENT.chipText },
        {
          type: "text",
          text: describeSchedule(o.cfg),
          size: FS.section,
          weight: "bold",
          color: WATCH_ACCENT.chipText,
          wrap: true,
          margin: "xs",
        },
        ...(o.nextLabel
          ? [{ type: "text", text: `รายงานถัดไป ~${o.nextLabel}`, size: FS.caption, color: WATCH_ACCENT.chipText, margin: "sm", wrap: true }]
          : []),
      ],
    },
    { type: "text", text: "แตะเพื่อเปลี่ยนรอบ", size: FS.label, weight: "bold", color: NEUTRAL.text, margin: "lg" },
    ...PRESETS.map((p) => presetRow(p, active === p.cmd)),
    softSep("lg"),
    {
      type: "text",
      text: "หรือพิมพ์เองได้: ทุก 30 นาที · ทุก 2 ชม. · เวลา 08:30, 12:00, 17:00\n(รับตั้งแต่ 15 นาที ถึง 24 ชม.)",
      size: FS.caption,
      color: NEUTRAL.muted,
      wrap: true,
      margin: "md",
    },
  ];

  if (o.justStarted) {
    body.push(softSep("lg"), {
      type: "text",
      text: "แจ้งทุกคนในกลุ่ม: บอทอ่านเฉพาะข้อความตัวอักษรเพื่อทำสรุปประเด็น ไม่เก็บรูป/ไฟล์/เสียง · ไม่ระบุชื่อผู้พูด · ลบอัตโนมัติใน 3 วัน\nพิมพ์ 'เฝ้าอะไรอยู่' ดูรายละเอียด · 'ไม่สรุปข้อความผม' เพื่อขอไม่ถูกสรุป",
      size: FS.caption,
      color: NEUTRAL.muted,
      wrap: true,
      margin: "md",
    });
  }

  return {
    type: "flex",
    altText: o.justStarted
      ? `เริ่มสรุปกลุ่มนี้แล้ว — ${describeSchedule(o.cfg)}`
      : `รอบรายงาน: ${describeSchedule(o.cfg)}`,
    contents: {
      type: "bubble",
      header: gradientHeader({
        accent: WATCH_ACCENT,
        eyebrow: o.justStarted ? "🔍 เริ่มสรุปกลุ่มนี้แล้ว" : "🕒 รอบรายงาน",
        title: short(o.groupName),
        subtitle: o.justStarted ? "ตั้งรอบได้เลย หรือปล่อยเป็นค่าเริ่มต้น" : "เลือกความถี่ที่ต้องการ",
      }),
      body: { type: "box", layout: "vertical", paddingAll: "20px", paddingTop: "14px", spacing: "none", contents: body },
      styles: { header: headerStyle(WATCH_ACCENT) },
    },
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

  const sched = describeSchedule(cfg);

  const kw = splitStored(cfg.keywords);
  const urgent = splitStored(cfg.urgentKeywords);

  return {
    type: "text",
    text: [
      `🔍 กลุ่มนี้กำลังถูกสรุปอยู่`,
      "",
      `ส่งสรุปไปที่: ${dest.join(" + ")}`,
      `รอบการส่ง: ${sched}  (เปลี่ยนได้ พิมพ์ "ตั้งรอบ")`,
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
      "รอบการส่ง (พิมพ์ 'ตั้งรอบ' เพื่อกดเลือก):",
      "• ทุก 30 นาที / ทุก 4 ชม. (15 นาที – 24 ชม.)",
      "• เวลา 09:00, 18:00 — ส่งตามนาฬิกา",
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
