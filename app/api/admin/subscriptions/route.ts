import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { requireAdmin, AdminAuthError } from "@/lib/admin-auth";

// Grants entitlements at runtime via the service client — never prerender.
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/subscriptions
 * Upserts into upl_module_subscriptions — buys/enables a module, à la carte or
 * included in the tenant's tier. Per SPEC.md §11 example:
 *
 * request:  { "module_key": "slip_verification", "billing_mode": "addon" }
 * response: { "ok": true, "subscription": { module_key, enabled, addon_price_thb,
 *              requires_api_key, next_step } }
 *
 * Guarded by requireAdmin (x-admin-token): this route grants entitlements, so it must be
 * protected — otherwise anyone could enable paid modules for any tenant.
 *
 * NOTE: tenant identity in a real deployment comes from the authenticated admin
 * session (Supabase auth on the Dashboard). This stub-free route accepts an explicit
 * tenant_id in the body for now — swap for session-derived tenant_id once auth
 * middleware is wired up in the Admin Dashboard.
 */

interface SubscriptionRequestBody {
  tenant_id: string;
  module_key: string;
  // Optional: if omitted, derived from the tenant's plan_tier vs the module's tier_min.
  billing_mode?: "included_in_tier" | "addon";
  // Optional: toggle a module on/off for the tenant (Manage Customers page). Defaults true.
  enabled?: boolean;
}

type PlanTier = "starter" | "pro" | "business";
const TIER_RANK: Record<PlanTier, number> = { starter: 0, pro: 1, business: 2 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: SubscriptionRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const { tenant_id, module_key } = body;
  const enabled = body.enabled ?? true;
  if (!tenant_id || !module_key) {
    return NextResponse.json(
      { ok: false, reason: "tenant_id and module_key are required" },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();

  const { data: moduleRow, error: moduleError } = await supabase
    .from("upl_module_catalog")
    .select("module_key, requires_api_key, addon_price_thb, tier_min")
    .eq("module_key", module_key)
    .maybeSingle();

  if (moduleError) {
    return NextResponse.json({ ok: false, reason: moduleError.message }, { status: 500 });
  }
  if (!moduleRow) {
    return NextResponse.json({ ok: false, reason: "unknown_module" }, { status: 404 });
  }

  // Derive billing_mode when the caller didn't specify it (e.g. the Manage page toggle):
  // included_in_tier if the module's minimum tier is at or below the tenant's plan, else addon.
  let billing_mode = body.billing_mode;
  if (!billing_mode) {
    const { data: tenantRow } = await supabase
      .from("upl_tenants")
      .select("plan_tier")
      .eq("id", tenant_id)
      .maybeSingle();
    const plan = (tenantRow?.plan_tier as PlanTier) ?? "starter";
    billing_mode =
      TIER_RANK[moduleRow.tier_min as PlanTier] <= TIER_RANK[plan] ? "included_in_tier" : "addon";
  }

  const { data: subscription, error: upsertError } = await supabase
    .from("upl_module_subscriptions")
    .upsert(
      {
        tenant_id,
        module_key,
        enabled,
        billing_mode,
      },
      { onConflict: "tenant_id,module_key" }
    )
    .select("module_key, enabled")
    .single();

  if (upsertError || !subscription) {
    return NextResponse.json(
      { ok: false, reason: upsertError?.message ?? "upsert_failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    subscription: {
      module_key: subscription.module_key,
      enabled: subscription.enabled,
      addon_price_thb: moduleRow.addon_price_thb,
      requires_api_key: moduleRow.requires_api_key,
      next_step: moduleRow.requires_api_key ? "connect_provider" : "ready",
    },
  });
}
