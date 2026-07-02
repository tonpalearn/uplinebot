import { AssistantModule } from "./assistant/handler";
import { BroadcastModule } from "./broadcast/handler";
import { SlipVerificationModule } from "./slip-verification/handler";
import { isModuleEntitled } from "../entitlement";
import type { LineEvent, ModuleHandler, OutboundMessage, TenantContext } from "./types";
import { getServiceClient } from "../db";

/**
 * Statically-imported module registry, keyed by module_key.
 * Per SYSTEM-DESIGN.md §4.2 — "adding a new module in P3/P4 never touches the
 * router, just register the new handler here and add its row to upl_module_catalog."
 *
 * This file must not be edited by anyone else later — it is wired to compile against
 * the stub handlers checked in alongside it.
 */
export const MODULE_REGISTRY: Record<string, ModuleHandler> = {
  assistant_productivity: AssistantModule,
  broadcast_campaigns: BroadcastModule,
  slip_verification: SlipVerificationModule,
  // ...remaining modules added as built, per SPEC.md §16 roadmap (P3/P4).
};

/**
 * Fixed priority order for the Command Router (SYSTEM-DESIGN.md §4.2, step 3):
 * Slip Verification is checked first since image messages are unambiguous, then
 * keyword/intent modules in the order below. Modules not present here (i.e. any
 * future module not yet added to this list) are simply never matched — safe by
 * construction, no router change needed until the maintainer adds it here.
 */
const ROUTER_PRIORITY: string[] = [
  "slip_verification",
  "assistant_productivity",
  "broadcast_campaigns",
];

async function loadModuleConfig(targetId: string, moduleKey: string): Promise<Record<string, unknown>> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_module_configs")
    .select("settings")
    .eq("target_id", targetId)
    .eq("module_key", moduleKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load module config for "${moduleKey}": ${error.message}`);
  }

  return (data?.settings as Record<string, unknown>) ?? {};
}

/**
 * Command Router — routeEvent().
 *
 * 1. Filters MODULE_REGISTRY to modules the tenant is entitled to (§4.1 guard),
 *    in the fixed ROUTER_PRIORITY order (Slip Verification first for image messages,
 *    then keyword modules).
 * 2. For each enabled candidate module, calls matchesIntent(); first match wins,
 *    handleEvent() runs and its OutboundMessage[] is returned.
 * 3. If no module matches, returns an empty array (silent) — expected behavior for
 *    groups in 'mention_only' mode, or for any event no purchased module handles.
 */
export async function routeEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
  for (const moduleKey of ROUTER_PRIORITY) {
    const handler = MODULE_REGISTRY[moduleKey];
    if (!handler) continue;

    const entitled = await isModuleEntitled(ctx.tenantId, moduleKey);
    if (!entitled) continue;

    const config = await loadModuleConfig(ctx.targetId, moduleKey);

    if (handler.matchesIntent(event, config)) {
      return handler.handleEvent(event, ctx);
    }
  }

  return [];
}
