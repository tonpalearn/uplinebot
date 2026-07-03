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

// Max reminders processed per cron tick. Anything beyond this drains on the next minute's
// tick (their reminded_at is still null), so nothing is lost — a big burst just spreads out.
const BATCH_LIMIT = 300;
// How many LINE pushes run concurrently. Keeps the whole batch well under the serverless
// function time limit while not hammering the LINE API with hundreds of parallel calls.
const PUSH_CONCURRENCY = 25;

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

  // Phase 1 — warm the per-target + per-bot caches (only unique targets/bots are fetched).
  for (const row of rows) {
    const target = await resolveTarget(row.target_id, targetCache);
    if (target) await resolveBotToken(target.botId, botTokenCache);
  }

  // Phase 2 — push + stamp reminded_at in PARALLEL chunks so hundreds of reminders due at the
  // same minute (across many customers) go out in a few seconds instead of one-by-one. Each
  // reminder stays scoped to its own target_id/bot, so customers never cross-contaminate.
  for (let i = 0; i < rows.length; i += PUSH_CONCURRENCY) {
    const chunk = rows.slice(i, i + PUSH_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map((row) => remindOne(row, now, targetCache, botTokenCache))
    );
    result.sent += outcomes.filter(Boolean).length;
  }

  return result;
}

/** Send one reminder (its target/bot are already in the caches) and stamp reminded_at. */
async function remindOne(
  row: DueTodoRow,
  now: Date,
  targetCache: Map<string, TargetInfo | null>,
  botTokenCache: Map<string, string | null>
): Promise<boolean> {
  try {
    const target = targetCache.get(row.target_id);
    if (!target) return false;

    const accessToken = botTokenCache.get(target.botId);
    if (!accessToken) return false;

    const messages: OutboundMessage[] = [
      {
        type: "text",
        text: `⏰ ถึงเวลางาน: ${row.content} (กำหนด ${formatThaiDueAt(new Date(row.due_at), now)})`,
      },
    ];

    await pushMessage(accessToken, target.lineSourceId, messages);

    const { error: updateError } = await getServiceClient()
      .from("upl_todos")
      .update({ reminded_at: now.toISOString() })
      .eq("id", row.id);

    if (updateError) {
      // Push already went out; log and move on rather than failing the batch.
      console.error(`Reminder sent but failed to stamp reminded_at for todo ${row.id}: ${updateError.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Todo reminder failed for todo ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
