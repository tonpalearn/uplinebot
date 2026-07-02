import { getServiceClient } from "./db";
import { pushMessage } from "./line/client";
import { decrypt } from "./crypto";
import { formatThaiDueAt } from "./modules/assistant/datetime";
import type { OutboundMessage } from "./modules/types";

/**
 * Time-based todo reminders — per SPEC.md §6.3 (Todo Manager) + migration 0003.
 *
 * scanTodoReminders(now) finds every todo whose due_at has arrived and that hasn't been
 * reminded yet (and isn't done), pushes a LINE reminder to that target's chat, then stamps
 * reminded_at so it never fires twice. Called by the cron dispatch route alongside
 * dispatchDueJobs(). Reuses the exact bot-credential lookup + decrypt + pushMessage pattern
 * from lib/scheduler/dispatcher.ts. A failure on one row is caught so the batch continues.
 */

const BATCH_LIMIT = 200;

interface DueTodoRow {
  id: string;
  target_id: string;
  content: string;
  due_at: string;
}

interface TargetInfo {
  lineSourceId: string;
  botId: string;
}

export interface ReminderScanResult {
  sent: number;
}

export async function scanTodoReminders(now: Date = new Date()): Promise<ReminderScanResult> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_todos")
    .select("id, target_id, content, due_at")
    .lte("due_at", now.toISOString())
    .eq("done", false)
    .is("reminded_at", null)
    .order("due_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new Error(`Failed to query due todo reminders: ${error.message}`);
  }

  const rows = (data ?? []) as DueTodoRow[];
  const result: ReminderScanResult = { sent: 0 };

  // Per-target and per-bot caches so a burst of due todos in the same chat doesn't refetch.
  const targetCache = new Map<string, TargetInfo | null>();
  const botTokenCache = new Map<string, string | null>();

  for (const row of rows) {
    try {
      const target = await resolveTarget(row.target_id, targetCache);
      if (!target) continue;

      const accessToken = await resolveBotToken(target.botId, botTokenCache);
      if (!accessToken) continue;

      const messages: OutboundMessage[] = [
        {
          type: "text",
          text: `⏰ ถึงเวลางาน: ${row.content} (กำหนด ${formatThaiDueAt(new Date(row.due_at), now)})`,
        },
      ];

      await pushMessage(accessToken, target.lineSourceId, messages);

      const { error: updateError } = await supabase
        .from("upl_todos")
        .update({ reminded_at: now.toISOString() })
        .eq("id", row.id);

      if (updateError) {
        // Push already went out; log and move on rather than aborting the batch.
        console.error(`Reminder sent but failed to stamp reminded_at for todo ${row.id}: ${updateError.message}`);
        continue;
      }

      result.sent += 1;
    } catch (err) {
      console.error(
        `Todo reminder failed for todo ${row.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

async function resolveTarget(
  targetId: string,
  cache: Map<string, TargetInfo | null>
): Promise<TargetInfo | null> {
  if (cache.has(targetId)) return cache.get(targetId) ?? null;

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_targets")
    .select("line_source_id, bot_id")
    .eq("id", targetId)
    .maybeSingle();

  const info: TargetInfo | null =
    error || !data
      ? null
      : { lineSourceId: data.line_source_id as string, botId: data.bot_id as string };

  cache.set(targetId, info);
  return info;
}

async function resolveBotToken(
  botId: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (cache.has(botId)) return cache.get(botId) ?? null;

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_bots")
    .select("access_token_enc")
    .eq("id", botId)
    .maybeSingle();

  // access_token_enc is a base64 text column (migration 0002) — decrypt() takes the string.
  const token = error || !data ? null : decrypt(data.access_token_enc as string);
  cache.set(botId, token);
  return token;
}
