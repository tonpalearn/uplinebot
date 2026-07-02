import { getServiceClient } from "./db";
import type { LineEvent, TenantContext } from "./modules/types";

/**
 * Context Resolver — per SYSTEM-DESIGN.md §2.2 / SPEC.md §10.1.
 *
 * Given a raw LINE webhook event plus a bot lookup (already resolved from the
 * destination channel in the webhook payload), resolve tenantId / targetId /
 * sourceType, upserting upl_targets as needed (first message from a new
 * user/group/room creates its target row).
 */

export interface BotLookup {
  id: string; // upl_bots.id
  tenantId: string; // upl_bots.tenant_id
}

function lineSourceId(event: LineEvent): { lineSourceId: string; sourceType: TenantContext["sourceType"] } {
  const { source } = event;
  if (source.type === "group" && source.groupId) {
    return { lineSourceId: source.groupId, sourceType: "group" };
  }
  if (source.type === "room" && source.roomId) {
    return { lineSourceId: source.roomId, sourceType: "room" };
  }
  if (source.userId) {
    return { lineSourceId: source.userId, sourceType: "user" };
  }
  throw new Error("LineEvent.source is missing an identifiable id (userId/groupId/roomId).");
}

export async function resolveContext(event: LineEvent, bot: BotLookup): Promise<TenantContext> {
  const supabase = getServiceClient();
  const { lineSourceId: sourceId, sourceType } = lineSourceId(event);

  // Upsert target: create on first contact, otherwise return existing row.
  const { data: existing, error: selectError } = await supabase
    .from("upl_targets")
    .select("id")
    .eq("bot_id", bot.id)
    .eq("line_source_id", sourceId)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to look up target: ${selectError.message}`);
  }

  if (existing?.id) {
    return {
      tenantId: bot.tenantId,
      targetId: existing.id,
      botId: bot.id,
      sourceType,
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("upl_targets")
    .insert({
      bot_id: bot.id,
      line_source_id: sourceId,
      source_type: sourceType,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(`Failed to upsert target: ${insertError?.message ?? "unknown error"}`);
  }

  return {
    tenantId: bot.tenantId,
    targetId: inserted.id,
    botId: bot.id,
    sourceType,
  };
}

/**
 * Looks up the bot (and its tenant) from the LINE destination channel id in the
 * webhook payload. Used by the webhook route handler before resolveContext().
 */
export async function lookupBotByChannelId(lineChannelId: string): Promise<BotLookup | null> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_bots")
    .select("id, tenant_id")
    .eq("line_channel_id", lineChannelId)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up bot by channel id: ${error.message}`);
  }

  if (!data) return null;

  return { id: data.id, tenantId: data.tenant_id };
}
