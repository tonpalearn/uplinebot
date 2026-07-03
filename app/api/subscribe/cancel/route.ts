import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { PUBLIC_SUB_COLUMNS, type SubscriptionRow } from "@/lib/subscriptions";

// Self-serve cancel / reactivate. The manage_token IS the auth. Never prerender.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { token?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const action = body.action === "reactivate" ? "reactivate" : "cancel";
  if (!token) return NextResponse.json({ ok: false, reason: "token is required" }, { status: 400 });

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "server_misconfigured" },
      { status: 500 }
    );
  }

  // Load current state (scoped by token) to decide the status transition.
  const { data: current, error: readErr } = await supabase
    .from("upl_customer_subscriptions")
    .select("id, status, cancel_at_period_end")
    .eq("manage_token", token)
    .maybeSingle();

  if (readErr) return NextResponse.json({ ok: false, reason: readErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });

  const cur = current as { id: string; status: SubscriptionRow["status"]; cancel_at_period_end: boolean };
  const patch: Record<string, unknown> = {};

  if (action === "cancel") {
    patch.cancel_at_period_end = true;
    patch.canceled_at = new Date().toISOString();
    // A subscription that never activated is canceled outright (nothing to run to period end).
    if (cur.status === "pending") patch.status = "canceled";
  } else {
    patch.cancel_at_period_end = false;
    patch.canceled_at = null;
    // Undo a pending-cancel back to pending; an active one just clears the "won't renew" flag.
    if (cur.status === "canceled") patch.status = "pending";
  }

  const { data, error } = await supabase
    .from("upl_customer_subscriptions")
    .update(patch)
    .eq("manage_token", token)
    .select(PUBLIC_SUB_COLUMNS)
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, reason: error?.message ?? "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, subscription: data as unknown as SubscriptionRow });
}
