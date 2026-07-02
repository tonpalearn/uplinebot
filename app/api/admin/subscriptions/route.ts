import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";

/**
 * POST /api/admin/subscriptions
 * Upserts into upl_module_subscriptions — buys/enables a module, à la carte or
 * included in the tenant's tier. Per SPEC.md §11 example:
 *
 * request:  { "module_key": "slip_verification", "billing_mode": "addon" }
 * response: { "ok": true, "subscription": { module_key, enabled, addon_price_thb,
 *              requires_api_key, next_step } }
 *
 * NOTE: tenant identity in a real deployment comes from the authenticated admin
 * session (Supabase auth on the Dashboard). This stub-free route accepts an explicit
 * tenant_id in the body for now — swap for session-derived tenant_id once auth
 * middleware is wired up in the Admin Dashboard.
 */

interface SubscriptionRequestBody {
  tenant_id: string;
  module_key: string;
  billing_mode: "included_in_tier" | "addon";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SubscriptionRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const { tenant_id, module_key, billing_mode } = body;
  if (!tenant_id || !module_key || !billing_mode) {
    return NextResponse.json(
      { ok: false, reason: "tenant_id, module_key and billing_mode are required" },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();

  const { data: moduleRow, error: moduleError } = await supabase
    .from("upl_module_catalog")
    .select("module_key, requires_api_key, addon_price_thb")
    .eq("module_key", module_key)
    .maybeSingle();

  if (moduleError) {
    return NextResponse.json({ ok: false, reason: moduleError.message }, { status: 500 });
  }
  if (!moduleRow) {
    return NextResponse.json({ ok: false, reason: "unknown_module" }, { status: 404 });
  }

  const { data: subscription, error: upsertError } = await supabase
    .from("upl_module_subscriptions")
    .upsert(
      {
        tenant_id,
        module_key,
        enabled: true,
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
