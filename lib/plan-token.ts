import { randomBytes } from "node:crypto";
import { getServiceClient } from "./db";

/**
 * Plan-token mechanism for the customer calendar web page.
 *
 * Each upl_targets row can carry a `plan_token` (migration 0003) — a URL-safe random
 * string that mints the per-target calendar link `${APP_BASE_URL}/plan/<token>`. The
 * planner phase builds the page + API; this module owns minting + validating the token.
 *
 * getOrCreatePlanToken(targetId): reads the target's token, generating + persisting one
 *   on first use. Idempotent per target.
 * validatePlanToken(token): reverse lookup — resolves a token to its { targetId, tenantId },
 *   or null if unknown. tenantId comes via target → bot join (upl_targets has no tenant_id).
 */

const DEFAULT_BASE_URL = "https://uplinebot-cyan.vercel.app";

/** Base URL used to build the /plan/<token> link. Trailing slash trimmed. */
export function planBaseUrl(): string {
  const raw = process.env.APP_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** Full customer calendar link for a given plan token. */
export function planLinkUrl(token: string): string {
  return `${planBaseUrl()}/plan/${token}`;
}

/** 24 random bytes → 32-char URL-safe base64url string (no padding, no +/). */
function generateToken(): string {
  return randomBytes(24)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Returns the target's plan token, creating and persisting one if it does not exist yet.
 */
export async function getOrCreatePlanToken(targetId: string): Promise<string> {
  const supabase = getServiceClient();

  const { data: existing, error: selectError } = await supabase
    .from("upl_targets")
    .select("plan_token")
    .eq("id", targetId)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to read plan_token for target ${targetId}: ${selectError.message}`);
  }

  const current = existing?.plan_token as string | null | undefined;
  if (current) return current;

  const token = generateToken();
  const { error: updateError } = await supabase
    .from("upl_targets")
    .update({ plan_token: token })
    .eq("id", targetId);

  if (updateError) {
    throw new Error(`Failed to persist plan_token for target ${targetId}: ${updateError.message}`);
  }

  return token;
}

/**
 * Resolves a plan token to its target + tenant, or null if the token is unknown.
 * tenantId is read from the owning bot (upl_targets → upl_bots.tenant_id).
 */
export async function validatePlanToken(
  token: string
): Promise<{ targetId: string; tenantId: string } | null> {
  if (!token) return null;
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_targets")
    .select("id, upl_bots(tenant_id)")
    .eq("plan_token", token)
    .maybeSingle();

  if (error || !data) return null;

  // supabase-js types an embedded to-one relation as an object OR array depending on the
  // inferred shape; normalize both to the tenant_id string.
  const botRel = (data as { upl_bots?: unknown }).upl_bots;
  const tenantId = Array.isArray(botRel)
    ? (botRel[0] as { tenant_id?: string } | undefined)?.tenant_id
    : (botRel as { tenant_id?: string } | undefined)?.tenant_id;

  if (!tenantId) return null;

  return { targetId: data.id as string, tenantId };
}
