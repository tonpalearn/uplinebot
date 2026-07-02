import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Manage-Customers toggle: POST /api/admin/subscriptions must
 *  - require the admin token (x-admin-token) — 401 without it,
 *  - honor `enabled` (so a module can be turned OFF, not just ON),
 *  - derive billing_mode from the tenant's plan_tier vs the module's tier_min
 *    when the caller omits it.
 */

process.env.ADMIN_TOKEN = "test-admin-token";

// Captures the row passed to upl_module_subscriptions.upsert so we can assert it.
let lastUpsert: Record<string, unknown> | null = null;

// Configurable fixtures per test.
const fixtures = {
  moduleTierMin: "pro" as "starter" | "pro" | "business",
  tenantPlan: "starter" as "starter" | "pro" | "business",
  moduleExists: true,
};

vi.mock("../lib/db", () => {
  function makeQuery(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (c: string, v: unknown) => {
        filters[c] = v;
        return builder;
      },
      maybeSingle: async () => {
        if (table === "upl_module_catalog") {
          if (!fixtures.moduleExists) return { data: null, error: null };
          return {
            data: {
              module_key: filters.module_key,
              requires_api_key: true,
              addon_price_thb: 990,
              tier_min: fixtures.moduleTierMin,
            },
            error: null,
          };
        }
        if (table === "upl_tenants") {
          return { data: { plan_tier: fixtures.tenantPlan }, error: null };
        }
        return { data: null, error: null };
      },
      upsert: (row: Record<string, unknown>) => {
        lastUpsert = row;
        return {
          select: () => ({
            single: async () => ({
              data: { module_key: row.module_key, enabled: row.enabled },
              error: null,
            }),
          }),
        };
      },
    };
    return builder;
  }
  return { getServiceClient: () => ({ from: (t: string) => makeQuery(t) }) };
});

import { POST } from "../app/api/admin/subscriptions/route";

function req(body: unknown, token: string | null = "test-admin-token"): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("x-admin-token", token);
  return new NextRequest("https://up-line.example.com/api/admin/subscriptions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  lastUpsert = null;
  fixtures.moduleTierMin = "pro";
  fixtures.tenantPlan = "starter";
  fixtures.moduleExists = true;
});

describe("POST /api/admin/subscriptions — toggle + billing derivation", () => {
  it("401 without admin token", async () => {
    const res = await POST(req({ tenant_id: "t1", module_key: "slip_verification" }, null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("enabled:false turns a module OFF (not forced to true)", async () => {
    const res = await POST(req({ tenant_id: "t1", module_key: "slip_verification", enabled: false }));
    expect(res.status).toBe(200);
    expect(lastUpsert?.enabled).toBe(false);
  });

  it("derives billing_mode=addon when module tier_min (pro) is above tenant plan (starter)", async () => {
    await POST(req({ tenant_id: "t1", module_key: "slip_verification" }));
    expect(lastUpsert?.billing_mode).toBe("addon");
    expect(lastUpsert?.enabled).toBe(true); // default when omitted
  });

  it("derives billing_mode=included_in_tier when module is within the tenant's plan", async () => {
    fixtures.moduleTierMin = "starter";
    fixtures.tenantPlan = "pro";
    await POST(req({ tenant_id: "t1", module_key: "broadcast_campaigns" }));
    expect(lastUpsert?.billing_mode).toBe("included_in_tier");
  });

  it("404 for an unknown module", async () => {
    fixtures.moduleExists = false;
    const res = await POST(req({ tenant_id: "t1", module_key: "nope" }));
    expect(res.status).toBe(404);
  });
});
