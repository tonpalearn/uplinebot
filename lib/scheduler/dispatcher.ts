import { getServiceClient } from "../db";
import { MODULE_REGISTRY } from "../modules/registry";
import { pushMessage } from "../line/client";
import { decrypt } from "../crypto";
import type { ScheduledJob, TenantContext } from "../modules/types";

/**
 * Cron job dispatcher — per SYSTEM-DESIGN.md §4.4.
 *
 * Queries upl_scheduled_jobs for due jobs, dispatches to the matching module's
 * handleScheduledJob() (looked up via MODULE_REGISTRY by job_type), sends the
 * resulting messages, then updates last_run_at/next_run_at. A failure on one
 * job is caught and logged without blocking the batch.
 */

const BATCH_LIMIT = 200;

/** Maps a scheduled job's job_type to the module_key that owns it. */
const JOB_TYPE_TO_MODULE_KEY: Record<ScheduledJob["jobType"], string> = {
  broadcast: "broadcast_campaigns",
  morning_brief: "assistant_productivity",
  booking_reminder: "booking_appointments",
  membership_renewal: "community_course",
};

interface DueJobRow {
  id: string;
  tenant_id: string;
  job_type: ScheduledJob["jobType"];
  ref_id: string | null;
  target_id: string | null;
  cron_expr: string | null;
  run_at: string | null;
  timezone: string;
  active: boolean;
}

function toScheduledJob(row: DueJobRow): ScheduledJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    jobType: row.job_type,
    refId: row.ref_id,
    targetId: row.target_id,
    cronExpr: row.cron_expr,
    runAt: row.run_at,
    timezone: row.timezone,
  };
}

/**
 * Computes the next run time for a recurring job. This is intentionally a minimal
 * cron-ish evaluator sufficient for the fixed set of schedules this system creates
 * (see SYSTEM-DESIGN.md §4.4 — morning_brief advances by 24h; other recurring jobs
 * are expected to follow the same "advance by interval" shape). Swap for a full
 * cron parser (e.g. a cron-parser package) if free-form cron_expr support is needed.
 */
function computeNextRunAt(job: DueJobRow, now: Date): Date | null {
  if (!job.cron_expr) {
    // One-shot job (run_at was set, no recurrence) — caller should deactivate instead.
    return null;
  }

  // Minimal support: cron_expr of the form "every_24h", "every_1h", etc.
  const match = /^every_(\d+)h$/.exec(job.cron_expr);
  if (match) {
    const hours = parseInt(match[1], 10);
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
  }

  // Fallback: advance by 24h (matches morning_brief default cadence).
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

async function resolveTenantContextForJob(job: DueJobRow): Promise<TenantContext | null> {
  if (!job.target_id) {
    // Tenant-wide job with no specific target (e.g. a broadcast fanning out to many
    // targets) — module's handleScheduledJob is responsible for resolving its own
    // audience in that case. We still hand back a context with an empty targetId
    // placeholder-free shape isn't valid, so we treat this as "module resolves it".
    return null;
  }

  const supabase = getServiceClient();
  const { data: target, error } = await supabase
    .from("upl_targets")
    .select("id, bot_id, source_type")
    .eq("id", job.target_id)
    .maybeSingle();

  if (error || !target) return null;

  return {
    tenantId: job.tenant_id,
    targetId: target.id,
    botId: target.bot_id,
    sourceType: target.source_type,
  };
}

export interface DispatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ jobId: string; message: string }>;
}

export async function dispatchDueJobs(now: Date = new Date()): Promise<DispatchResult> {
  const supabase = getServiceClient();

  const { data: dueJobs, error } = await supabase
    .from("upl_scheduled_jobs")
    .select("id, tenant_id, job_type, ref_id, target_id, cron_expr, run_at, timezone, active")
    .eq("active", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new Error(`Failed to query due scheduled jobs: ${error.message}`);
  }

  const result: DispatchResult = { processed: 0, succeeded: 0, failed: 0, errors: [] };

  for (const row of (dueJobs ?? []) as DueJobRow[]) {
    result.processed += 1;
    try {
      await dispatchOneJob(row, now);
      result.succeeded += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        jobId: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function dispatchOneJob(row: DueJobRow, now: Date): Promise<void> {
  const supabase = getServiceClient();
  const job = toScheduledJob(row);
  const moduleKey = JOB_TYPE_TO_MODULE_KEY[job.jobType];
  const handler = moduleKey ? MODULE_REGISTRY[moduleKey] : undefined;

  if (!handler?.handleScheduledJob) {
    throw new Error(`No handler.handleScheduledJob registered for job_type "${job.jobType}"`);
  }

  const ctx = await resolveTenantContextForJob(row);
  if (!ctx) {
    throw new Error(`Could not resolve TenantContext for job ${row.id}`);
  }

  const messages = await handler.handleScheduledJob(job, ctx);

  if (messages.length > 0 && row.target_id) {
    const bot = await lookupBotCredentials(ctx.botId);
    if (bot) {
      await pushMessage(bot.accessToken, await lookupLineSourceId(row.target_id), messages);
    }
  }

  const nextRunAt = computeNextRunAt(row, now);

  const { error: updateError } = await supabase
    .from("upl_scheduled_jobs")
    .update({
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt ? nextRunAt.toISOString() : row.run_at ?? now.toISOString(),
      active: nextRunAt ? true : false,
    })
    .eq("id", row.id);

  if (updateError) {
    throw new Error(`Failed to update job ${row.id} after dispatch: ${updateError.message}`);
  }
}

async function lookupBotCredentials(botId: string): Promise<{ accessToken: string } | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_bots")
    .select("access_token_enc")
    .eq("id", botId)
    .maybeSingle();

  if (error || !data) return null;

  return { accessToken: decrypt(Buffer.from(data.access_token_enc)) };
}

async function lookupLineSourceId(targetId: string): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_targets")
    .select("line_source_id")
    .eq("id", targetId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`Could not resolve line_source_id for target ${targetId}`);
  }

  return data.line_source_id as string;
}
