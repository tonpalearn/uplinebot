import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { requireAdmin, AdminAuthError } from "@/lib/admin-auth";

// Provisions tenants + grants entitlements at runtime via the service client — never prerender.
export const dynamic = "force-dynamic";

/**
 * /api/admin/tenants — seller-only tenant onboarding (guarded by requireAdmin).
 *
 * POST  create a tenant + grant which modules it may use (entitlements).
 * GET   list tenants with their enabled module_keys.
 *
 * Step 1 of onboarding a new customer: an admin creates the tenant and grants modules.
 * Step 2 (connect the customer's LINE OA) is POST /api/admin/bots.
 */

type PlanTier = "starter" | "pro" | "business";

const PLAN_TIERS: PlanTier[] = ["starter", "pro", "business"];

// Rank for tier comparison: starter(0) < pro(1) < business(2).
const TIER_RANK: Record<PlanTier, number> = { starter: 0, pro: 1, business: 2 };

interface CreateTenantBody {
  name: string;
  plan_tier: PlanTier;
  module_keys: string[];
}

/**
 * A module is "included_in_tier" when its minimum tier is at or below the tenant's chosen
 * plan tier (e.g. a 'pro' tenant gets every starter/pro module included); otherwise the
 * tenant is buying it à la carte above their tier, so it's an "addon".
 */
function billingModeFor(moduleTierMin: PlanTier, planTier: PlanTier): "included_in_tier" | "addon" {
  return TIER_RANK[moduleTierMin] <= TIER_RANK[planTier] ? "included_in_tier" : "addon";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: CreateTenantBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const { name, plan_tier, module_keys } = body;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ ok: false, reason: "name is required" }, { status: 400 });
  }
  if (!PLAN_TIERS.includes(plan_tier)) {
    return NextResponse.json(
      { ok: false, reason: "plan_tier must be one of starter|pro|business" },
      { status: 400 }
    );
  }
  if (!Array.isArray(module_keys)) {
    return NextResponse.json({ ok: false, reason: "module_keys must be an array" }, { status: 400 });
  }

  const supabase = getServiceClient();

  // 1. Create the tenant.
  const { data: tenant, error: tenantError } = await supabase
    .from("upl_tenants")
    .insert({ name, plan_tier })
    .select("id, name, plan_tier, trial_ends_at, created_at")
    .single();

  if (tenantError || !tenant) {
    return NextResponse.json(
      { ok: false, reason: tenantError?.message ?? "tenant_insert_failed" },
      { status: 500 }
    );
  }

  // 2. Grant modules (entitlements). Validate each key exists in the catalog and derive
  //    billing_mode from the module's tier_min vs the tenant's plan_tier.
  let subscriptions: Array<{ module_key: string; enabled: boolean; billing_mode: string }> = [];

  const uniqueKeys = Array.from(new Set(module_keys));
  if (uniqueKeys.length > 0) {
    const { data: catalogRows, error: catalogError } = await supabase
      .from("upl_module_catalog")
      .select("module_key, tier_min")
      .in("module_key", uniqueKeys);

    if (catalogError) {
      return NextResponse.json({ ok: false, reason: catalogError.message }, { status: 500 });
    }

    const tierByKey = new Map<string, PlanTier>(
      (catalogRows ?? []).map((r) => [r.module_key as string, r.tier_min as PlanTier])
    );

    const unknown = uniqueKeys.filter((k) => !tierByKey.has(k));
    if (unknown.length > 0) {
      return NextResponse.json(
        { ok: false, reason: `unknown module_keys: ${unknown.join(", ")}` },
        { status: 400 }
      );
    }

    const rows = uniqueKeys.map((module_key) => ({
      tenant_id: tenant.id,
      module_key,
      enabled: true,
      billing_mode: billingModeFor(tierByKey.get(module_key)!, plan_tier),
    }));

    const { data: inserted, error: subError } = await supabase
      .from("upl_module_subscriptions")
      .insert(rows)
      .select("module_key, enabled, billing_mode");

    if (subError) {
      return NextResponse.json({ ok: false, reason: subError.message }, { status: 500 });
    }
    subscriptions = inserted ?? [];
  }

  return NextResponse.json({ ok: true, tenant, subscriptions });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const supabase = getServiceClient();

  const { data: tenants, error: tenantsError } = await supabase
    .from("upl_tenants")
    .select("id, name, plan_tier, trial_ends_at, created_at")
    .order("created_at", { ascending: false });

  if (tenantsError) {
    return NextResponse.json({ ok: false, reason: tenantsError.message }, { status: 500 });
  }

  const tenantList = tenants ?? [];

  // Attach each tenant's enabled module_keys.
  const { data: subs, error: subsError } = await supabase
    .from("upl_module_subscriptions")
    .select("tenant_id, module_key, enabled")
    .eq("enabled", true);

  if (subsError) {
    return NextResponse.json({ ok: false, reason: subsError.message }, { status: 500 });
  }

  const keysByTenant = new Map<string, string[]>();
  for (const s of subs ?? []) {
    const list = keysByTenant.get(s.tenant_id as string) ?? [];
    list.push(s.module_key as string);
    keysByTenant.set(s.tenant_id as string, list);
  }

  const result = tenantList.map((t) => ({
    ...t,
    module_keys: keysByTenant.get(t.id as string) ?? [],
  }));

  return NextResponse.json({ ok: true, tenants: result });
}

interface UpdateTenantBody {
  id: string;
  name?: string;
  plan_tier?: PlanTier;
}

// PATCH — edit a customer (tenant): rename or change plan tier. Only provided fields change.
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: UpdateTenantBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (body.plan_tier !== undefined) {
    if (!PLAN_TIERS.includes(body.plan_tier)) {
      return NextResponse.json(
        { ok: false, reason: "plan_tier must be one of starter|pro|business" },
        { status: 400 }
      );
    }
    patch.plan_tier = body.plan_tier;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, reason: "no updatable fields provided" }, { status: 400 });
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_tenants")
    .update(patch)
    .eq("id", id)
    .select("id, name, plan_tier, trial_ends_at, created_at")
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, tenant: data });
}

// DELETE — remove a customer (tenant) entirely. DESTRUCTIVE + irreversible: FKs are ON DELETE
// CASCADE, so this also drops the tenant's bots (+ their targets/todos/ledger/KM), module
// entitlements, KM, logs, etc. Self-serve payment rows (upl_customer_subscriptions.tenant_id)
// are SET NULL, so the payment history is preserved rather than deleted.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_tenants")
    .delete()
    .eq("id", id)
    .select("id, name")
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: data });
}
