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
  logReport,
  type WatchConfig,
} from "./store";
import { summarizeConversation, fallbackSummary, type WatchSummary } from "./summarize";
import {
  buildSummaryCard,
  buildStatusText,
  buildStartedText,
  buildStoppedText,
  buildOptOutText,
  buildNoNewsText,
  buildHelpText,
} from "./flex";
import { pushMessage } from "../../line/client";
import { getBotAccessToken } from "../../line/token";

/**
 * ผู้ช่วยเฝ้ากลุ่ม (module_key: group_watcher) — โมดูลที่ 17.
 *
 * ต่างจากโมดูลอื่นตรงที่ **ข้อความส่วนใหญ่ที่ผ่านมาไม่ใช่คำสั่ง** แต่คือบทสนทนาที่ต้องเก็บ
 * ไว้สรุป. matchesIntent จึงคืน true กับข้อความตัวอักษรในกลุ่มทุกอัน (เมื่อเปิดใช้งาน)
 * แล้ว handleEvent เป็นคนแยกว่า "คำสั่ง → ตอบ" หรือ "บทสนทนา → เก็บเงียบ ๆ คืน []"
 *
 * ⚠️ อยู่ท้าย ROUTER_PRIORITY (ก่อน faq เท่านั้น) — ถ้าอยู่ต้น มันจะกลืนคำสั่งของทุกโมดูล
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

/**
 * ส่งสรุปไปยังปลายทางที่ตั้งไว้ — คืนคำอธิบายปลายทางแบบอ่านออก (ไว้ลง log)
 * ส่งไม่ออกสักที่ = คืน null เพื่อให้ผู้เรียก "ไม่ mark ว่าสรุปแล้ว" (ข้อความจะถูกสรุปรอบหน้า)
 */
export async function deliverSummary(
  cfg: WatchConfig,
  botId: string,
  card: OutboundMessage
): Promise<string | null> {
  const token = await getBotAccessToken(botId);
  const sent: string[] = [];

  if (cfg.reportToUser) {
    const r = await pushMessage(token, cfg.reportToUser, [card]);
    if (r.ok) sent.push("แชทส่วนตัว");
  }
  if (cfg.reportToTarget) {
    const r = await pushMessage(token, cfg.reportToTarget, [card]);
    if (r.ok) sent.push("กลุ่มปลายทาง");
  }

  return sent.length > 0 ? sent.join(" + ") : null;
}

/** สร้างสรุป + ส่ง + บันทึก — ใช้ร่วมกันระหว่างคำสั่ง "สรุปตอนนี้", คำสำคัญ, และ cron */
export async function runSummary(
  cfg: WatchConfig,
  botId: string,
  groupName: string,
  kind: "scheduled" | "keyword" | "manual",
  triggeredBy: string | null = null
): Promise<{ delivered: boolean; count: number; summary: WatchSummary | null }> {
  const pending = await getPending(cfg.targetId);
  if (pending.ids.length === 0) return { delivered: false, count: 0, summary: null };

  // รอบตามเวลา: ข้อความน้อยเกินเกณฑ์ = ไม่รบกวน (คำสำคัญ/สั่งเองไม่ติดเงื่อนไขนี้)
  if (kind === "scheduled" && pending.ids.length < cfg.minMessages) {
    return { delivered: false, count: pending.ids.length, summary: null };
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

  const deliveredTo = await deliverSummary(cfg, botId, card);
  if (!deliveredTo) return { delivered: false, count: pending.ids.length, summary };

  // mark หลังส่งสำเร็จเท่านั้น — ส่งไม่ออกแล้ว mark ไปแล้ว = บทสนทนาหายไปเงียบ ๆ
  await markSummarized(pending.ids);
  await logReport(
    cfg.targetId,
    kind,
    pending.ids.length,
    [...summary.topics, ...summary.actions].join(" | "),
    deliveredTo
  );

  return { delivered: true, count: pending.ids.length, summary };
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
      await startWatch(ctx.targetId, ctx.tenantId, lineUserId);
      return [buildStartedText(groupName)];
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

    if (intent?.action === "watch_stop") {
      await updateWatchConfig(ctx.targetId, { active: false });
      return [buildStoppedText()];
    }

    if (intent?.action === "set_interval") {
      await updateWatchConfig(ctx.targetId, {
        scheduleKind: "interval",
        intervalMinutes: intent.minutes,
      });
      const label =
        intent.minutes >= 60 ? `${Math.round(intent.minutes / 60)} ชั่วโมง` : `${intent.minutes} นาที`;
      return [{ type: "text", text: `🕒 ตั้งรอบสรุปเป็นทุก ${label} แล้ว` }];
    }

    if (intent?.action === "set_times") {
      await updateWatchConfig(ctx.targetId, {
        scheduleKind: "times",
        reportTimes: intent.times.join(","),
      });
      return [{ type: "text", text: `🕒 จะสรุปให้เวลา ${intent.times.join(", ")} น. ทุกวัน` }];
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
