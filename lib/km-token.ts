import { randomBytes } from "node:crypto";
import { getServiceClient } from "./db";

/**
 * KM-token mechanism for the Knowledge Base admin web page — mirrors lib/ledger-token.ts, but
 * scoped per **TENANT** (a business's whole KB), not per target/chat. One token opens the
 * management page for every KM entry the tenant owns, across all their groups.
 *
 * Each upl_tenants row can carry a `km_token` (migration 0009) — a URL-safe random string that
 * mints the admin link `${APP_BASE_URL}/km/<token>`. The bot sends it via the "คลังความรู้"
 * command; the token IS the auth for the /km page + /api/km API.
 *
 * getOrCreateKmToken(tenantId): reads the tenant's token, generating + persisting one on first
 *   use. Idempotent per tenant.
 * validateKmToken(token): reverse lookup → { tenantId } or null (upl_tenants by km_token).
 * kmManageUrl(token): full `${APP_BASE_URL}/km/<token>` link.
 */

const DEFAULT_BASE_URL = "https://uplinebot.vercel.app";

/** Base URL used to build the /km/<token> link. Trailing slash trimmed. */
export function kmBaseUrl(): string {
  const raw = process.env.APP_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** Full Knowledge Base management link for a given km token. */
export function kmManageUrl(token: string): string {
  return `${kmBaseUrl()}/km/${token}`;
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
 * Returns the tenant's km token, creating and persisting one if it does not exist yet.
 * Idempotent — a second call for the same tenant returns the same token.
 */
export async function getOrCreateKmToken(tenantId: string): Promise<string> {
  const supabase = getServiceClient();

  const { data: existing, error: selectError } = await supabase
    .from("upl_tenants")
    .select("km_token")
    .eq("id", tenantId)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to read km_token for tenant ${tenantId}: ${selectError.message}`);
  }

  const current = existing?.km_token as string | null | undefined;
  if (current) return current;

  const token = generateToken();
  const { error: updateError } = await supabase
    .from("upl_tenants")
    .update({ km_token: token })
    .eq("id", tenantId);

  if (updateError) {
    throw new Error(`Failed to persist km_token for tenant ${tenantId}: ${updateError.message}`);
  }

  return token;
}

/**
 * Resolves a km token to its tenant, or null if the token is unknown.
 * Unlike the ledger/plan tokens (target-scoped, joined through the bot), km_token lives
 * directly on upl_tenants, so this is a single-table lookup.
 */
export async function validateKmToken(token: string): Promise<{ tenantId: string } | null> {
  if (!token) return null;
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_tenants")
    .select("id")
    .eq("km_token", token)
    .maybeSingle();

  if (error || !data) return null;

  return { tenantId: data.id as string };
}
