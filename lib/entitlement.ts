import { getServiceClient } from "./db";

/**
 * Thrown when a tenant attempts to use a module they have not enabled/purchased.
 *
 * - Webhook path: the Command Router calls assertModuleEntitled per candidate module
 *   BEFORE invoking its handler; catch this error and silently skip the module
 *   (not an error state to the LINE user) — see lib/modules/registry.ts routeEvent().
 * - Admin API path: catch this error and return a 402-style
 *   { ok:false, reason:"not_subscribed" } response.
 */
export class EntitlementError extends Error {
  public readonly moduleKey: string;

  constructor(moduleKey: string) {
    super(`Module "${moduleKey}" is not enabled for this tenant.`);
    this.name = "EntitlementError";
    this.moduleKey = moduleKey;
  }
}

/**
 * Per SYSTEM-DESIGN.md §4.1 — Module Entitlement Guard (BFF middleware).
 * Throws EntitlementError if the module is not enabled for the tenant.
 */
export async function assertModuleEntitled(tenantId: string, moduleKey: string): Promise<void> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_module_subscriptions")
    .select("enabled")
    .eq("tenant_id", tenantId)
    .eq("module_key", moduleKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check entitlement for module "${moduleKey}": ${error.message}`);
  }

  if (!data?.enabled) {
    throw new EntitlementError(moduleKey);
  }
}

/**
 * Non-throwing variant, useful for the Command Router which needs to filter a whole
 * list of candidate modules without try/catch per module.
 */
export async function isModuleEntitled(tenantId: string, moduleKey: string): Promise<boolean> {
  try {
    await assertModuleEntitled(tenantId, moduleKey);
    return true;
  } catch (err) {
    if (err instanceof EntitlementError) return false;
    throw err;
  }
}
