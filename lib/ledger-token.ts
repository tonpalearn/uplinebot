import { randomBytes } from "node:crypto";
import { getServiceClient } from "./db";

/**
 * Ledger-token mechanism for the expense-tracker web report — mirrors lib/plan-token.ts but
 * on `upl_targets.ledger_token` and the `/ledger/<token>` path.
 *
 * Each upl_targets row can carry a `ledger_token` — a URL-safe random string that mints the
 * per-target report link `${APP_BASE_URL}/ledger/<token>`. The expense-tracker sends it to the
 * customer via the bot's "รายงาน" command; the token IS the auth for the report page + API.
 *
 * getOrCreateLedgerToken(targetId): reads the target's token, generating + persisting one on
 *   first use. Idempotent per target.
 * validateLedgerToken(token): reverse lookup → { targetId, tenantId }, or null if unknown.
 *   tenantId comes via target → bot join (upl_targets has no tenant_id).
 */

const DEFAULT_BASE_URL = "https://uplinebot.vercel.app";

/** Base URL used to build the /ledger/<token> link. Trailing slash trimmed. */
export function ledgerBaseUrl(): string {
  const raw = process.env.APP_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** Full customer report link for a given ledger token. */
export function ledgerReportUrl(token: string): string {
  return `${ledgerBaseUrl()}/ledger/${token}`;
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
 * Returns the target's ledger token, creating and persisting one if it does not exist yet.
 */
export async function getOrCreateLedgerToken(targetId: string): Promise<string> {
  const supabase = getServiceClient();

  const { data: existing, error: selectError } = await supabase
    .from("upl_targets")
    .select("ledger_token")
    .eq("id", targetId)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to read ledger_token for target ${targetId}: ${selectError.message}`);
  }

  const current = existing?.ledger_token as string | null | undefined;
  if (current) return current;

  const token = generateToken();
  const { error: updateError } = await supabase
    .from("upl_targets")
    .update({ ledger_token: token })
    .eq("id", targetId);

  if (updateError) {
    throw new Error(`Failed to persist ledger_token for target ${targetId}: ${updateError.message}`);
  }

  return token;
}

/**
 * Resolves a ledger token to its target + tenant, or null if the token is unknown.
 * tenantId is read from the owning bot (upl_targets → upl_bots.tenant_id).
 */
export async function validateLedgerToken(
  token: string
): Promise<{ targetId: string; tenantId: string } | null> {
  if (!token) return null;
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_targets")
    .select("id, upl_bots(tenant_id)")
    .eq("ledger_token", token)
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
