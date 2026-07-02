import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Admin API authentication — a single shared-secret gate for the seller-only
 * onboarding endpoints (create tenant, grant modules, connect a customer's LINE OA).
 *
 * These endpoints provision tenants and grant entitlements, so they must be locked to
 * the platform owner (Toni / the seller), NOT exposed to tenant managers or the public.
 * The caller must send the secret in the `x-admin-token` request header; it is compared
 * against process.env.ADMIN_TOKEN.
 *
 * FAILS CLOSED: if ADMIN_TOKEN is not configured on the server, every call is rejected
 * (a missing secret is treated as misconfiguration, never as "auth disabled").
 *
 * This is deliberately simple and stateless — the seller is a single operator, so a
 * shared bearer-style secret is sufficient. Per-tenant, session-based admin auth
 * (Supabase auth via upl_users_admin) is a separate concern used by the tenant Dashboard.
 */

const ADMIN_TOKEN_HEADER = "x-admin-token";

/** Thrown when an admin-only request is missing/has a wrong token, or the server is misconfigured. */
export class AdminAuthError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AdminAuthError";
  }
}

/**
 * Assert the request carries a valid admin token. Throws AdminAuthError otherwise.
 * Fails closed when ADMIN_TOKEN is unset.
 */
export function requireAdmin(req: Request | NextRequest): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    // Misconfigured server — refuse rather than silently allowing everything through.
    throw new AdminAuthError("admin_token_not_configured");
  }

  const provided = req.headers.get(ADMIN_TOKEN_HEADER);
  if (!provided || provided !== expected) {
    throw new AdminAuthError("unauthorized");
  }
}

/**
 * Convenience wrapper: run requireAdmin and, if it throws AdminAuthError, return the
 * standard 401 response so route handlers can early-return without their own try/catch.
 *
 *   const denied = adminGuard(req);
 *   if (denied) return denied;
 *
 * Returns null when the request is authorized. Re-throws any non-AdminAuthError.
 */
export function adminGuard(req: Request | NextRequest): NextResponse | null {
  try {
    requireAdmin(req);
    return null;
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
