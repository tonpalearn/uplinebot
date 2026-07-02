import type {
  ModuleHandler,
  LineEvent,
  ModuleConfig,
  TenantContext,
  OutboundMessage,
  ScheduledJob,
} from "../types";
import { getServiceClient } from "../../db";
import { renderBroadcastPayload, type TemplateVariables } from "./template";

/**
 * Broadcast & Campaigns (module_key: broadcast_campaigns)
 * Source: SPEC.md §6.4 (Broadcast module), SYSTEM-DESIGN.md §4.2 / §4.4.
 *
 * Two entry points:
 * - matchesIntent/handleEvent: keyword auto-reply — a target's
 *   upl_module_configs.settings carries `trigger_keyword` + `trigger_reply_text`;
 *   an inbound text message matching the keyword gets the configured reply back
 *   immediately (distinct from the scheduled/cron broadcast send below).
 * - handleScheduledJob: cron-driven broadcast send — job_type 'broadcast' points
 *   (via job.refId) at an upl_broadcasts row; its jsonb payload is rendered with
 *   {{variable}} substitution and returned as OutboundMessage[] to be pushed to
 *   job.targetId by the dispatcher (lib/scheduler/dispatcher.ts).
 */

interface TriggerReplySettings {
  trigger_keyword?: unknown;
  trigger_reply_text?: unknown;
}

function getTriggerKeyword(config: ModuleConfig): string | null {
  const settings = config as TriggerReplySettings;
  return typeof settings.trigger_keyword === "string" && settings.trigger_keyword.trim().length > 0
    ? settings.trigger_keyword
    : null;
}

function getTriggerReplyText(config: ModuleConfig): string | null {
  const settings = config as TriggerReplySettings;
  return typeof settings.trigger_reply_text === "string" ? settings.trigger_reply_text : null;
}

/**
 * matchesIntent() only receives the target's module config (per ModuleHandler),
 * but handleEvent() only receives (event, ctx) — so handleEvent reloads the same
 * config itself, keyed off ctx.targetId, to stay a self-contained implementation
 * of the shared ModuleHandler interface (lib/modules/types.ts, not owned by this module).
 */
async function loadModuleConfig(targetId: string): Promise<ModuleConfig> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_module_configs")
    .select("settings")
    .eq("target_id", targetId)
    .eq("module_key", "broadcast_campaigns")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load broadcast_campaigns config for target "${targetId}": ${error.message}`);
  }

  return (data?.settings as ModuleConfig) ?? {};
}

interface BroadcastRow {
  id: string;
  tenant_id: string;
  message_type: "text" | "flex";
  payload: Record<string, unknown>;
}

async function loadBroadcastById(broadcastId: string): Promise<BroadcastRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_broadcasts")
    .select("id, tenant_id, message_type, payload")
    .eq("id", broadcastId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load broadcast "${broadcastId}": ${error.message}`);
  }

  return (data as BroadcastRow) ?? null;
}

/**
 * Variables available to {{...}} substitution for a scheduled broadcast job.
 * Currently supports a rendered-at date placeholder; extend here as more
 * per-job variables (e.g. target display_name) become available to the dispatcher.
 */
function buildScheduledJobVariables(job: ScheduledJob, now: Date = new Date()): TemplateVariables {
  return {
    date: now.toLocaleDateString("th-TH", { timeZone: job.timezone || "Asia/Bangkok" }),
  };
}

export const BroadcastModule: ModuleHandler = {
  key: "broadcast_campaigns",

  matchesIntent(event: LineEvent, config: ModuleConfig): boolean {
    const keyword = getTriggerKeyword(config);
    if (!keyword) return false;

    const text = event.message?.type === "text" ? event.message.text : undefined;
    if (!text) return false;

    return text.trim() === keyword.trim();
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const config = await loadModuleConfig(ctx.targetId);
    const keyword = getTriggerKeyword(config);
    const text = event.message?.type === "text" ? event.message.text : undefined;
    if (!keyword || !text || text.trim() !== keyword.trim()) return [];

    const replyText = getTriggerReplyText(config);
    if (!replyText) return [];

    return [{ type: "text", text: replyText }];
  },

  async handleScheduledJob(job: ScheduledJob, _ctx: TenantContext): Promise<OutboundMessage[]> {
    if (job.jobType !== "broadcast" || !job.refId) return [];

    const broadcast = await loadBroadcastById(job.refId);
    if (!broadcast) return [];

    const variables = buildScheduledJobVariables(job);

    return [renderBroadcastPayload(broadcast, variables)];
  },
};
