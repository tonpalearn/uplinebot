import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";

/**
 * GET /api/admin/module-catalog
 * Returns all rows from upl_module_catalog (global, not tenant-scoped).
 * Per SPEC.md §11 BFF API Contract: "GET /api/admin/module-catalog — Mgr —
 * ดูโมดูลทั้งหมด + ราคา + requires_api_key".
 */
export async function GET(): Promise<NextResponse> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_module_catalog")
    .select("module_key, name, requires_api_key, tier_min, addon_price_thb, is_core")
    .order("module_key", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, modules: data });
}
