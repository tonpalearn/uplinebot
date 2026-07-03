import { AssistantModule } from "./assistant/handler";
import { BroadcastModule } from "./broadcast/handler";
import { SlipVerificationModule } from "./slip-verification/handler";
import { ExpenseTrackerModule } from "./expense-tracker/handler";
import { isModuleEntitled } from "../entitlement";
import type { LineEvent, ModuleHandler, OutboundMessage, TenantContext } from "./types";
import { getServiceClient } from "../db";

/**
 * Statically-imported module registry, keyed by module_key.
 * Per SYSTEM-DESIGN.md §4.2 — "adding a new module in P3/P4 never touches the
 * router, just register the new handler here and add its row to upl_module_catalog."
 *
 * This file must not be edited by anyone else later — it is wired to compile against
 * the stub handlers checked in alongside it.
 */
export const MODULE_REGISTRY: Record<string, ModuleHandler> = {
  assistant_productivity: AssistantModule,
  broadcast_campaigns: BroadcastModule,
  slip_verification: SlipVerificationModule,
  expense_tracker: ExpenseTrackerModule,
  // ...remaining modules added as built, per SPEC.md §16 roadmap (P3/P4).
};

/**
 * Fixed priority order for the Command Router (SYSTEM-DESIGN.md §4.2, step 3):
 * Slip Verification is checked first since image messages are unambiguous, then
 * keyword/intent modules in the order below. Modules not present here (i.e. any
 * future module not yet added to this list) are simply never matched — safe by
 * construction, no router change needed until the maintainer adds it here.
 */
const ROUTER_PRIORITY: string[] = [
  "slip_verification",
  // Broadcast trigger keywords (exact-match) get first shot at TEXT.
  "broadcast_campaigns",
  // Assistant (Todo) is checked BEFORE Expense Tracker so its explicit commands win — most
  // importantly "ลบ N" (delete todo #N), which the ledger parser would otherwise read as a
  // ฿N record. Todo only matches its own commands (เพิ่ม/ค้าง/ลบ N/เลื่อน/วางแผน/…); everything
  // else (money lines like "กาแฟ 50", and สรุป/รายงาน/ยกเลิก) falls through to Expense Tracker.
  "assistant_productivity",
  "expense_tracker",
];

async function loadModuleConfig(targetId: string, moduleKey: string): Promise<Record<string, unknown>> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_module_configs")
    .select("settings")
    .eq("target_id", targetId)
    .eq("module_key", moduleKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load module config for "${moduleKey}": ${error.message}`);
  }

  return (data?.settings as Record<string, unknown>) ?? {};
}

/**
 * Group reply-mode gate. In 1:1 chats the bot always responds. In a group/room the bot's
 * group_reply_mode decides whether a TEXT message is acted on:
 *   - 'all'          → always respond
 *   - 'mention_only' → only when the bot itself is @mentioned (the bot's mention is then
 *                      stripped from the text so the remaining words are the command/task)
 *   - 'prefix'       → only when the text starts with the bot's default_prefix (stripped)
 * Non-text events (e.g. a slip image) are never gated — they pass through regardless of mode.
 *
 * Returns the (possibly text-cleaned) event to route, or null to stay silent.
 */
async function applyReplyGate(event: LineEvent, ctx: TenantContext): Promise<LineEvent | null> {
  if (ctx.sourceType === "user") return event;
  if (event.type !== "message" || event.message?.type !== "text") return event;

  const supabase = getServiceClient();
  const { data: bot } = await supabase
    .from("upl_bots")
    .select("group_reply_mode, default_prefix, line_channel_id")
    .eq("id", ctx.botId)
    .maybeSingle();

  const mode = (bot?.group_reply_mode as string) ?? "mention_only";
  if (mode === "all") return event;

  const text = event.message.text ?? "";

  if (mode === "mention_only") {
    const mentionees = event.message.mention?.mentionees ?? [];
    const botMentions = mentionees.filter((m) => m.userId && m.userId === bot?.line_channel_id);
    if (botMentions.length === 0) return null; // bot not mentioned → silent
    return withText(event, stripMentions(text, botMentions));
  }

  if (mode === "prefix") {
    const prefix = ((bot?.default_prefix as string) ?? "").trim();
    const t = text.trimStart();
    if (!prefix || !t.startsWith(prefix)) return null;
    return withText(event, t.slice(prefix.length).trim());
  }

  return null;
}

/** Remove the bot's @mention substrings (by index/length, highest first) and trim. */
function stripMentions(text: string, mentions: Array<{ index?: number; length?: number }>): string {
  const ranges = mentions
    .filter((m) => typeof m.index === "number" && typeof m.length === "number")
    .sort((a, b) => (b.index as number) - (a.index as number));
  let out = text;
  for (const m of ranges) {
    const i = m.index as number;
    const len = m.length as number;
    if (i >= 0 && i + len <= out.length) out = out.slice(0, i) + out.slice(i + len);
  }
  return out.trim();
}

/** Shallow-clone an event with a replaced message.text. */
function withText(event: LineEvent, text: string): LineEvent {
  return { ...event, message: event.message ? { ...event.message, text } : event.message };
}

/**
 * Command Router — routeEvent().
 *
 * 0. Applies the group reply-mode gate (mention_only/prefix/all). Silent if it fails.
 * 1. Filters MODULE_REGISTRY to modules the tenant is entitled to (§4.1 guard),
 *    in the fixed ROUTER_PRIORITY order (Slip Verification first for image messages,
 *    then keyword modules).
 * 2. For each enabled candidate module, calls matchesIntent(); first match wins,
 *    handleEvent() runs and its OutboundMessage[] is returned.
 * 3. If no module matches, returns an empty array (silent).
 */
export async function routeEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
  const gated = await applyReplyGate(event, ctx);
  if (!gated) return [];
  event = gated;

  for (const moduleKey of ROUTER_PRIORITY) {
    const handler = MODULE_REGISTRY[moduleKey];
    if (!handler) continue;

    const entitled = await isModuleEntitled(ctx.tenantId, moduleKey);
    if (!entitled) continue;

    const config = await loadModuleConfig(ctx.targetId, moduleKey);

    if (handler.matchesIntent(event, config)) {
      return handler.handleEvent(event, ctx);
    }
  }

  return [];
}
