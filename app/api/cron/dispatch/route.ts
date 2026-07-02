import { NextRequest, NextResponse } from "next/server";
import { dispatchDueJobs } from "@/lib/scheduler/dispatcher";
import { scanTodoReminders } from "@/lib/reminders";

// Never prerender/cache — invoked on a schedule and must run live per request.
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/dispatch
 *
 * Real handler (not a stub) per SYSTEM-DESIGN.md §4.4 — hit by a Vercel Cron entry.
 * Accepts EITHER the Vercel-native `Authorization: Bearer <CRON_SECRET>` header (which
 * Vercel injects automatically when CRON_SECRET env is set) OR a manual `x-cron-secret`
 * header (for local/manual triggering), then calls the scheduled job dispatcher.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const xCronSecret = req.headers.get("x-cron-secret");

  const authorized =
    !!expectedSecret &&
    (authHeader === `Bearer ${expectedSecret}` || xCronSecret === expectedSecret);

  if (!authorized) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  try {
    // Share a single `now` across both scans so a job and a todo reminder due at the same
    // instant are evaluated against the same clock.
    const now = new Date();
    const jobs = await dispatchDueJobs(now);
    const reminders = await scanTodoReminders(now);
    return NextResponse.json({ ok: true, jobs, reminders });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
