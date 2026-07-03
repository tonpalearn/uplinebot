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
// Upper bound on the "remind before" lead (24h). Also the look-ahead window: we fetch tasks
// due within [now, now + MAX_LEAD] and then fire only those whose (due_at - lead) has passed.
export const MAX_LEAD_MINUTES = 1440;

/** Effective lead (minutes before due) for a task: its own override wins, else the target
 *  default, else 0. Clamped to [0, MAX_LEAD_MINUTES]. Pure — unit-tested. */
export function reminderLead(taskOverride: number | null | undefined, targetDefault: number | null | undefined): number {
  const raw = taskOverride ?? targetDefault ?? 0;
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.trunc(raw), MAX_LEAD_MINUTES);
}

/** Whether a task should be reminded now: fire when now >= due_at - lead. Pure — unit-tested. */
export function isReminderDue(dueAtMs: number, nowMs: number, leadMinutes: number): boolean {
  return dueAtMs - leadMinutes * 60_000 <= nowMs;
}

interface DueTodoRow {
  id: string;
  target_id: string;
  content: string;
  due_at: string;
  remind_before_minutes: number | null;
}

interface TargetInfo {
  lineSourceId: string;
  botId: string;
  reminderLeadMinutes: number;
}

export interface ReminderScanResult {
  sent: number;
}

export async function scanTodoReminders(now: Date = new Date()): Promise<ReminderScanResult> {
  const supabase = getServiceClient();

  // Look-ahead window: fetch tasks due within the next MAX_LEAD_MINUTES (so a task with a lead
  // time is fetched BEFORE its due moment), then fire only those whose (due_at - lead) has passed.
  const windowEnd = new Date(now.getTime() + MAX_LEAD_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("upl_todos")
    .select("id, target_id, content, due_at, remind_before_minutes")
    .lte("due_at", windowEnd)
    .eq("done", false)
    .is("reminded_at", null)
    .order("due_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new Error(`Failed to query due todo reminders: ${error.message}`);
  }

  const candidates = (data ?? []) as DueTodoRow[];
  const result: ReminderScanResult = { sent: 0 };

  // Per-target and per-bot caches so a burst of due todos in the same chat doesn't refetch.
  const targetCache = new Map<string, TargetInfo | null>();
  const botTokenCache = new Map<string, string | null>();

  // Phase 1 — resolve each target (warming caches for the push) AND keep only rows whose
  // effective remind moment (due_at - lead) has arrived. lead = task override ?? target default.
  const due: DueTodoRow[] = [];
  for (const row of candidates) {
    const target = await resolveTarget(row.target_id, targetCache);
    if (!target) continue;
    await resolveBotToken(target.botId, botTokenCache);
    const lead = reminderLead(row.remind_before_minutes, target.reminderLeadMinutes);
    if (isReminderDue(Date.parse(row.due_at), now.getTime(), lead)) due.push(row);
  }

  // Phase 2 — push + stamp reminded_at in PARALLEL chunks so hundreds of reminders due at the
  // same minute (across many customers) go out in a few seconds instead of one-by-one. Each
  // reminder stays scoped to its own target_id/bot, so customers never cross-contaminate.
  for (let i = 0; i < due.length; i += PUSH_CONCURRENCY) {
    const chunk = due.slice(i, i + PUSH_CONCURRENCY);
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

    // Ahead-of-time reminder → "อีก X นาที"; at/after due → "ถึงเวลางาน".
    const minutesUntil = Math.round((Date.parse(row.due_at) - now.getTime()) / 60_000);
    const head =
      minutesUntil >= 1 ? `⏰ ใกล้ถึงกำหนด (อีก ${minutesUntil} นาที)` : "⏰ ถึงเวลางาน";
    const messages: OutboundMessage[] = [
      {
        type: "text",
        text: `${head}: ${row.content} (กำหนด ${formatThaiDueAt(new Date(row.due_at), now)})`,
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
    .select("line_source_id, bot_id, reminder_lead_minutes")
    .eq("id", targetId)
    .maybeSingle();

  const info: TargetInfo | null =
    error || !data
      ? null
      : {
          lineSourceId: data.line_source_id as string,
          botId: data.bot_id as string,
          reminderLeadMinutes: (data.reminder_lead_minutes as number | null) ?? 0,
        };

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
