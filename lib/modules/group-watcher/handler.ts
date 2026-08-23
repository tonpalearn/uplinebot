import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage } from "../types";
import { parseWatchIntent, matchKeywords, splitStored } from "./parse";
import {
  getWatchConfig,
  startWatch,
  updateWatchConfig,
  captureMessage,
  getPending,
  markSummarized,
  setOptOut,
  countOptOuts,
  lastReportAt,
  logReport,
  type WatchConfig,
} from "./store";
import { summarizeConversation, fallbackSummary, type WatchSummary } from "./summarize";
import {
  buildSummaryCard,
  buildStatusText,
  buildScheduleCard,
  buildStoppedText,
  buildOptOutText,
  buildNoNewsText,
  buildHelpText,
} from "./flex";
import { pushMessage } from "../../line/client";
import { getBotAccessToken } from "../../line/token";
import { isModuleEntitled } from "../../entitlement";
import { describeSchedule, nextReportLabel } from "./schedule";

/**
 * ผู้ช่วยเฝ้ากลุ่ม (module_key: group_watcher) — โมดูลที่ 17.
 *
 * แยกเป็น **2 เส้นทาง** โดยตั้งใจ:
 *   1. คำสั่ง (เฝ้ากลุ่มนี้ / สรุปตอนนี้ / เฝ้าอะไรอยู่ …) → ผ่าน Command Router ตามปกติ
 *      matchesIntent จึงรับ **เฉพาะคำสั่งของตัวเอง**
 *   2. การเก็บบทสนทนา → `captureIfWatched()` ที่ webhook เรียก **ก่อน** เข้า router
 *
 * ทำไมต้องแยก: router เป็น first-match-wins — ถ้าโมดูลนี้รับ "ข้อความทุกอัน" เพื่อจะเก็บ
 * บทสนทนา มันจะกลืนคำสั่งของ FAQ (exact_trigger เปิด default) และทุกโมดูลที่อยู่หลังมันทันที
 * การเฝ้าคือ "การสังเกตข้าง ๆ" ไม่ใช่การรับงาน จึงไม่ควรอยู่ใน router ตั้งแต่แรก
 *
 * กติกาความเป็นส่วนตัวที่บังคับในโค้ดนี้:
 *   • เก็บเฉพาะ event ที่เป็น "ข้อความตัวอักษรในกลุ่ม" — รูป/ไฟล์/เสียง/สติกเกอร์ ไม่แตะ
 *   • ไม่เก็บถ้าคนพูด opt-out ไว้ (เช็คใน captureMessage)
 *   • คำสั่งความโปร่งใส (เฝ้าอะไรอยู่ / ไม่สรุปข้อความผม) ทำงานได้แม้คนพิมพ์ไม่ใช่เจ้าของ
 */

/** ชื่อกลุ่มที่แสดงบนการ์ด — LINE ไม่ส่งชื่อกลุ่มมากับ event จึงใช้ id ท่อนท้ายแทน */
function groupLabel(ctx: TenantContext): string {
  return ctx.sourceType === "group" || ctx.sourceType === "room"
    ? `กลุ่ม ${ctx.targetId.slice(0, 8)}`
    : "แชทนี้";
}

function periodLabel(firstAt: string | null, lastAt: string | null): string {
  const fmt = (iso: string) =>
    new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(11, 16);
  if (!firstAt || !lastAt) return "—";
  return firstAt === lastAt ? fmt(firstAt) : `${fmt(firstAt)}–${fmt(lastAt)} น.`;
}

export interface DeliveryResult {
  /** คำอธิบายปลายทางที่ส่งสำเร็จ — null = ไม่สำเร็จสักที่ */
  deliveredTo: string | null;
  /** เหตุผลที่ปลายทางแต่ละอันพลาด เช่น 'แชทส่วนตัว: 403 …' — ว่าง = ไม่มีอันไหนพลาด */
  failures: string[];
}

/**
 * ส่งสรุปไปยังปลายทางที่ตั้งไว้
 *
 * ส่งไม่ออกสักที่ = deliveredTo เป็น null เพื่อให้ผู้เรียก "ไม่ mark ว่าสรุปแล้ว"
 * (ข้อความจะถูกสรุปรอบหน้าแทนที่จะหายเงียบ)
 *
 * **ต้องคืนเหตุผลที่พลาดออกมาด้วยเสมอ** — ของเดิมเช็คแค่ r.ok แล้วทิ้ง status/body ของ LINE ทิ้ง
 * ผลคือเวลาสรุปไม่ถึงมือ อาการที่เห็นคือ "เงียบ" เหมือนกันหมด ไม่ว่าจะเพราะยังไม่ได้แอดเพื่อน
 * โควตาหมด โทเคนหมดอายุ หรือการ์ดผิดรูปแบบ — แยกไม่ออกจนกว่าจะไปนั่งเดา
 */
export async function deliverSummary(
  cfg: WatchConfig,
  botId: string,
  card: OutboundMessage
): Promise<DeliveryResult> {
  const token = await getBotAccessToken(botId);
  const sent: string[] = [];
  const failures: string[] = [];

  const send = async (to: string, label: string) => {
    const r = await pushMessage(token, to, [card]);
    if (r.ok) {
      sent.push(label);
      return;
    }
    // เก็บข้อความจาก LINE ไว้สั้น ๆ พอให้บอกได้ว่าเป็นปัญหาอะไร โดยไม่ทำให้ log บวม
    const detail =
      typeof r.body === "object" && r.body !== null && "message" in r.body
        ? String((r.body as { message: unknown }).message).slice(0, 120)
        : "";
    failures.push(`${label}: HTTP ${r.status}${detail ? ` — ${detail}` : ""}`);
  };

  if (cfg.reportToUser) await send(cfg.reportToUser, "แชทส่วนตัว");
  if (cfg.reportToTarget) await send(cfg.reportToTarget, "กลุ่มปลายทาง");
  if (!cfg.reportToUser && !cfg.reportToTarget) {
    failures.push("ยังไม่ได้ตั้งปลายทาง (พิมพ์ 'ส่งสรุปให้ผม' หรือ 'ส่งสรุปที่นี่')");
  }

  return { deliveredTo: sent.length > 0 ? sent.join(" + ") : null, failures };
}

/** สร้างสรุป + ส่ง + บันทึก — ใช้ร่วมกันระหว่างคำสั่ง "สรุปตอนนี้", คำสำคัญ, และ cron */
export async function runSummary(
  cfg: WatchConfig,
  botId: string,
  groupName: string,
  kind: "scheduled" | "keyword" | "manual",
  triggeredBy: string | null = null
): Promise<{ delivered: boolean; count: number; summary: WatchSummary | null; failures: string[] }> {
  const pending = await getPending(cfg.targetId);
  if (pending.ids.length === 0) return { delivered: false, count: 0, summary: null, failures: [] };

  // รอบตามเวลา: ข้อความน้อยเกินเกณฑ์ = ไม่รบกวน (คำสำคัญ/สั่งเองไม่ติดเงื่อนไขนี้)
  if (kind === "scheduled" && pending.ids.length < cfg.minMessages) {
    return { delivered: false, count: pending.ids.length, summary: null, failures: [] };
  }

  const ai = await summarizeConversation(pending.lines, { includeNames: cfg.includeNames });
  const summary = ai ?? fallbackSummary(pending.ids.length);

  const card = buildSummaryCard({
    groupName,
    summary,
    messageCount: pending.ids.length,
    periodLabel: periodLabel(pending.firstAt, pending.lastAt),
    triggeredBy,
    includeNames: cfg.includeNames,
  });

  const { deliveredTo, failures } = await deliverSummary(cfg, botId, card);
  if (!deliveredTo) return { delivered: false, count: pending.ids.length, summary, failures };

  // mark หลังส่งสำเร็จเท่านั้น — ส่งไม่ออกแล้ว mark ไปแล้ว = บทสนทนาหายไปเงียบ ๆ
  await markSummarized(pending.ids);
  await logReport(
    cfg.targetId,
    kind,
    pending.ids.length,
    [...summary.topics, ...summary.actions].join(" | "),
    deliveredTo
  );

  return { delivered: true, count: pending.ids.length, summary, failures };
}

/**
 * ข้อความยืนยันหลังตั้งรอบ — ต้องตอบคำถามที่คนถามจริง ๆ คือ "แล้วสรุปจะมาตอนไหน"
 * ของเดิมตอบแค่ "ตั้งแล้ว" ซึ่งทำให้ไม่มีใครรู้ว่ามันทำงานหรือเปล่าจนกว่าจะรอทั้งวัน
 */
function scheduleConfirm(cfg: WatchConfig, last: Date | null): OutboundMessage {
  const next = nextReportLabel(cfg, last, new Date());
  return {
    type: "text",
    text: [
      `🕒 ตั้งรอบสรุปเป็น "${describeSchedule(cfg)}" แล้ว`,
      next ? `รายงานถัดไป ~${next}` : null,
      "",
      "อยากสรุปเดี๋ยวนี้เลย พิมพ์: สรุปตอนนี้",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  };
}

export const GroupWatcherModule: ModuleHandler = {
  key: "group_watcher",

  matchesIntent(event: LineEvent, _config: ModuleConfig): boolean {
    // **รับเฉพาะคำสั่งของตัวเอง** — ห้ามรับ "ข้อความทุกอัน"
    //
    // Command Router เป็นแบบ first-match-wins: ถ้าโมดูลนี้แมตช์ข้อความทุกอันเพื่อจะเก็บบทสนทนา
    // มันจะกลืนคำสั่งของ FAQ (exact_trigger เปิดโดยค่าเริ่มต้น) และของทุกโมดูลที่อยู่หลังมัน
    // การ "เฝ้า" จึงไม่ใช่งานของ router — มันคือการสังเกตข้าง ๆ ที่ทำใน webhook ก่อนเข้า router
    // (ดู captureIfWatched ด้านล่าง ที่ webhook เรียกทุกข้อความ)
    if (event.type !== "message" || event.message?.type !== "text") return false;
    return parseWatchIntent(event.message.text ?? "") !== null;
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const text = event.message?.text ?? "";
    const intent = parseWatchIntent(text);
    const lineUserId = event.source.userId ?? null;
    const groupName = groupLabel(ctx);

    // ── คำสั่งที่ต้องทำงานได้เสมอ แม้ยังไม่เปิดเฝ้า ────────────────────────────
    if (intent?.action === "help") return [buildHelpText()];

    if (intent?.action === "watch_start") {
      // เปิดได้เฉพาะในกลุ่ม — เปิดในแชท 1:1 ไม่มีความหมาย (บอทสรุปบทสนทนาของตัวเองให้ตัวเอง)
      if (ctx.sourceType === "user") {
        return [
          { type: "text", text: "คำสั่งนี้ใช้ในกลุ่มเท่านั้น — เชิญบอทเข้ากลุ่มแล้วพิมพ์ 'เฝ้ากลุ่มนี้' ในกลุ่มนั้น" },
        ];
      }
      const started = await startWatch(ctx.targetId, ctx.tenantId, lineUserId);
      // การ์ดนี้ทำ 2 หน้าที่พร้อมกัน: ประกาศตัวให้คนในกลุ่มรู้ + โชว์รอบรายงานให้ตั้งได้ทันที
      // ของเดิมเป็นข้อความล้วนที่ไม่พูดถึงรอบเลย คนเปิดใช้จึงไม่มีทางรู้ว่าตั้งความถี่ได้
      return [
        buildScheduleCard({
          cfg: started,
          groupName,
          nextLabel: nextReportLabel(started, null, new Date()),
          justStarted: true,
        }),
      ];
    }

    const cfg = await getWatchConfig(ctx.targetId);

    if (intent?.action === "status") {
      return [buildStatusText(cfg, groupName, cfg ? await countOptOuts(ctx.targetId) : 0)];
    }

    if (intent?.action === "optout") {
      if (!lineUserId) {
        return [{ type: "text", text: "ไม่สามารถระบุตัวคุณได้จากข้อความนี้ ลองใหม่อีกครั้ง" }];
      }
      await setOptOut(ctx.targetId, lineUserId, intent.on);
      return [buildOptOutText(intent.on)];
    }

    // ── ตั้งแต่นี้ไปต้องเปิดเฝ้าอยู่ก่อน ──────────────────────────────────────
    if (!cfg || !cfg.active) {
      // ไม่ได้เฝ้า = ไม่เก็บ ไม่ตอบ (เงียบสนิท ให้คนคุยกันตามปกติ)
      return [];
    }

    if (intent?.action === "schedule_menu") {
      return [
        buildScheduleCard({
          cfg,
          groupName,
          nextLabel: nextReportLabel(cfg, await lastReportAt(ctx.targetId), new Date()),
        }),
      ];
    }

    if (intent?.action === "watch_stop") {
      await updateWatchConfig(ctx.targetId, { active: false });
      return [buildStoppedText()];
    }

    if (intent?.action === "set_interval") {
      await updateWatchConfig(ctx.targetId, {
        scheduleKind: "interval",
        intervalMinutes: intent.minutes,
      });
      const next = { ...cfg, scheduleKind: "interval" as const, intervalMinutes: intent.minutes };
      return [scheduleConfirm(next, await lastReportAt(ctx.targetId))];
    }

    if (intent?.action === "set_times") {
      await updateWatchConfig(ctx.targetId, {
        scheduleKind: "times",
        reportTimes: intent.times.join(","),
      });
      const next = { ...cfg, scheduleKind: "times" as const, reportTimes: intent.times.join(",") };
      return [scheduleConfirm(next, await lastReportAt(ctx.targetId))];
    }

    if (intent?.action === "set_keywords") {
      const joined = intent.keywords.join(", ");
      await updateWatchConfig(
        ctx.targetId,
        intent.urgent ? { urgentKeywords: joined } : { keywords: joined }
      );
      return [
        {
          type: "text",
          text: intent.urgent
            ? `🔴 ตั้งคำที่ถือว่าด่วนแล้ว: ${joined}\nเจอเมื่อไหร่จะเด้งทันทีพร้อมป้ายเตือน`
            : `🔔 ตั้งคำสำคัญแล้ว: ${joined}\nเจอเมื่อไหร่จะสรุปส่งให้ทันที ไม่รอรอบ`,
        },
      ];
    }

    if (intent?.action === "set_report_to") {
      if (intent.to === "me") {
        if (!lineUserId) return [{ type: "text", text: "ระบุตัวคุณไม่ได้จากข้อความนี้" }];
        await updateWatchConfig(ctx.targetId, { reportToUser: lineUserId });
        return [
          {
            type: "text",
            text: "📬 จะส่งสรุปเข้าแชทส่วนตัวของคุณ\n(ถ้ายังไม่เคยทักบอทเป็นการส่วนตัว ให้ทักบอทก่อน 1 ครั้ง ไม่งั้นส่งไม่ได้)",
          },
        ];
      }
      await updateWatchConfig(ctx.targetId, { reportToTarget: ctx.targetId });
      return [{ type: "text", text: "📬 จะส่งสรุปลงในกลุ่มนี้" }];
    }

    if (intent?.action === "set_names") {
      await updateWatchConfig(ctx.targetId, { includeNames: intent.on });
      return [
        {
          type: "text",
          text: intent.on
            ? "👤 สรุปจะระบุชื่อผู้พูดด้วย — แจ้งให้คนในกลุ่มทราบด้วยว่าเปิดไว้"
            : "🕶️ สรุปจะไม่ระบุชื่อผู้พูดแล้ว (สรุปเป็นประเด็นอย่างเดียว)",
        },
      ];
    }

    if (intent?.action === "summarize_now") {
      const r = await runSummary(cfg, ctx.botId, groupName, "manual");
      if (r.count === 0) return [buildNoNewsText(groupName)];
      if (!r.delivered) {
        return [
          {
            type: "text",
            text: "ส่งสรุปไม่สำเร็จ — ยังไม่ได้ตั้งปลายทาง หรือบอทส่งหาคุณไม่ได้\nพิมพ์ 'ส่งสรุปให้ผม' หรือ 'ส่งสรุปที่นี่' แล้วลองใหม่",
          },
        ];
      }
      return [{ type: "text", text: `📤 ส่งสรุป ${r.count} ข้อความให้แล้ว` }];
    }

    return [];
  },
};

/**
 * เก็บบทสนทนา + เช็คคำสำคัญ — **เรียกจาก webhook ทุกข้อความ ก่อนเข้า Command Router**
 *
 * แยกออกมาจาก ModuleHandler โดยตั้งใจ: การเฝ้าเป็น "การสังเกตข้าง ๆ" ไม่ใช่การรับงาน
 * ถ้าเอาไปไว้ใน router (first-match-wins) มันจะกลืนคำสั่งของโมดูลอื่นทั้งหมด
 *
 * ไม่ throw เด็ดขาด — อยู่บนเส้นทาง webhook ถ้าพังต้องไม่ทำให้บอทตอบข้อความไม่ได้
 */
export async function captureIfWatched(event: LineEvent, ctx: TenantContext): Promise<void> {
  try {
    if (event.type !== "message" || event.message?.type !== "text") return;
    // เฝ้าเฉพาะกลุ่ม — แชท 1:1 ไม่ต้องสรุปให้ตัวเอง
    if (ctx.sourceType === "user") return;

    const text = event.message.text ?? "";
    if (!text.trim()) return;

    const cfg = await getWatchConfig(ctx.targetId);
    if (!cfg || !cfg.active) return;

    // ⚠️ ต้องเช็คสิทธิ์ที่นี่ด้วย — เส้นทางนี้ไม่ได้ผ่าน Command Router จึงไม่ได้รับการกรอง
    // สิทธิ์อัตโนมัติเหมือนคำสั่ง. ถ้าลูกค้าเลิกใช้โมดูล (enabled=false) แต่ config ยังค้างอยู่
    // บอทจะเก็บบทสนทนาของคนในกลุ่มต่อไปเรื่อย ๆ ทั้งที่ไม่มีสิทธิ์แล้ว — ยอมไม่ได้
    if (!(await isModuleEntitled(ctx.tenantId, "group_watcher"))) return;

    // คำสั่งของโมดูลเองไม่ต้องเก็บเป็นบทสนทนา (ไม่งั้นสรุปจะเต็มไปด้วยคำสั่งตั้งค่า)
    if (parseWatchIntent(text) !== null) return;

    // LINE ไม่ส่งชื่อผู้พูดมากับ event — ต้องเรียก profile API แยกซึ่งจะกลายเป็น 1 คำขอ
    // ต่อ 1 ข้อความ (แพงและช้าเกินไป). ค่าเริ่มต้นคือไม่ระบุชื่ออยู่แล้ว จึงเก็บ null ไปก่อน
    const captured = await captureMessage(ctx.targetId, event.source.userId ?? null, null, text);
    if (!captured) return; // คนนี้ opt-out ไว้

    // คำสำคัญ → เด้งทันที (มี cooldown กันสแปมตัวเองเวลาคุยเรื่องนั้นรัว ๆ)
    const hits = [
      ...matchKeywords(text, splitStored(cfg.urgentKeywords)),
      ...matchKeywords(text, splitStored(cfg.keywords)),
    ];
    if (hits.length === 0 || inCooldown(cfg)) return;

    await updateWatchConfig(ctx.targetId, { lastAlertAt: new Date().toISOString() });
    await runSummary(cfg, ctx.botId, groupLabel(ctx), "keyword", hits[0]);
  } catch (err) {
    console.warn(`[watch] capture failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** ยังอยู่ในช่วงพักหลังเพิ่งเด้งไปหรือเปล่า */
function inCooldown(cfg: WatchConfig): boolean {
  if (!cfg.lastAlertAt || cfg.alertCooldownMinutes <= 0) return false;
  const since = Date.now() - new Date(cfg.lastAlertAt).getTime();
  return since < cfg.alertCooldownMinutes * 60_000;
}
