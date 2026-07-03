import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { adminGuard } from "@/lib/admin-auth";

// Onboarding helper: surface the Bot User IDs LINE has actually sent (webhook `destination`),
// so the operator copies the real value instead of hunting for the right "U..." in the console.
// A destination NOT yet matched to an upl_bots row is almost certainly the bot being onboarded.
export const dynamic = "force-dynamic";

interface LogRow {
  destination: string | null;
  outcome: string | null;
  created_at: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = adminGuard(req);
  if (denied) return denied;

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "server_misconfigured" },
      { status: 500 }
    );
  }

  // Pull recent inbound hits, then group by destination in JS (Supabase has no group-by helper).
  const { data, error } = await supabase
    .from("upl_webhook_log")
    .select("destination, outcome, created_at")
    .not("destination", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as LogRow[];

  // Which destinations are already connected as a bot (so we can flag the un-onboarded one).
  const { data: botData } = await supabase.from("upl_bots").select("line_channel_id");
  const known = new Set(
    ((botData ?? []) as unknown as { line_channel_id: string | null }[])
      .map((b) => b.line_channel_id)
      .filter(Boolean) as string[]
  );

  const byDest = new Map<
    string,
    { destination: string; count: number; latest: string; matched: boolean; lastOutcome: string | null }
  >();
  for (const r of rows) {
    const d = r.destination as string;
    const existing = byDest.get(d);
    if (existing) {
      existing.count += 1;
    } else {
      byDest.set(d, {
        destination: d,
        count: 1,
        latest: r.created_at, // rows are newest-first, so the first seen is the latest
        matched: known.has(d),
        lastOutcome: r.outcome,
      });
    }
  }

  const destinations = [...byDest.values()]
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .slice(0, 10);

  return NextResponse.json({ ok: true, destinations });
}
