import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { adminGuard } from "@/lib/admin-auth";
import { PUBLIC_SUB_COLUMNS, type SubscriptionRow } from "@/lib/subscriptions";

// Seller-only management of self-serve subscriptions (review pending → activate on payment).
// Distinct from /api/admin/subscriptions, which manages per-tenant MODULE entitlements.
export const dynamic = "force-dynamic";

const SETTABLE_STATUS = new Set(["active", "pending", "canceled", "past_due"]);

// ── GET: list subscriptions (optional ?status=) ─────────────────────────────────────────
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

  const status = req.nextUrl.searchParams.get("status")?.trim();
  let query = supabase
    .from("upl_customer_subscriptions")
    .select(PUBLIC_SUB_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(200);
  if (status && SETTABLE_STATUS.has(status)) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, subscriptions: (data ?? []) as unknown as SubscriptionRow[] });
}

// ── POST: set a subscription's status (e.g. confirm payment → active) ────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = adminGuard(req);
  if (denied) return denied;

  let body: { ref?: unknown; id?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "active";

  if (!ref && !id) return NextResponse.json({ ok: false, reason: "ref or id is required" }, { status: 400 });
  if (!SETTABLE_STATUS.has(status)) return NextResponse.json({ ok: false, reason: "invalid_status" }, { status: 400 });

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "server_misconfigured" },
      { status: 500 }
    );
  }

  const patch: Record<string, unknown> = { status };
  if (status === "active") {
    patch.activated_at = new Date().toISOString();
    patch.cancel_at_period_end = false;
    patch.canceled_at = null;
  }

  let query = supabase.from("upl_customer_subscriptions").update(patch);
  query = ref ? query.eq("payment_ref", ref) : query.eq("id", id);

  const { data, error } = await query.select(PUBLIC_SUB_COLUMNS).maybeSingle();
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, subscription: data as unknown as SubscriptionRow });
}
