import { NextRequest, NextResponse } from "next/server";
import { dispatchDueJobs } from "@/lib/scheduler/dispatcher";

/**
 * GET /api/cron/dispatch
 *
 * Real handler (not a stub) per SYSTEM-DESIGN.md §4.4 — hit by a single Vercel Cron
 * entry (`* * * * *`, 1-min resolution). Checks a CRON_SECRET header, then calls the
 * scheduled job dispatcher.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const providedSecret = req.headers.get("x-cron-secret");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await dispatchDueJobs();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
