import { describe, it, expect, vi, beforeEach } from "vitest";
import { decrypt } from "../lib/crypto";

/**
 * Onboarding API tests for the seller-only admin routes:
 *   app/api/admin/tenants/route.ts  (create tenant + grant module entitlements)
 *   app/api/admin/bots/route.ts     (connect a customer's LINE OA — secrets encrypted)
 *
 * lib/db.ts's getServiceClient() is mocked with an in-memory fake that mimics the exact
 * PostgREST query-builder chains the two routes use:
 *   upl_tenants:              .insert(obj).select(cols).single()          -> { data, error }
 *   upl_module_catalog:       .select(cols).in(col, values)              -> { data, error }
 *   upl_module_subscriptions: .insert(rows).select(cols)                 -> { data, error }
 *   upl_bots:                 .insert(obj).select(cols).single()          -> { data, error }
 *
 * ADMIN_TOKEN is set below so requireAdmin() has a configured secret to compare against.
 * ENCRYPTION_KEY is intentionally left unset (see tests/setup.ts) so lib/crypto uses its
 * labeled reversible STUB_B64: stub — decrypt() still round-trips it back to plaintext,
 * which is enough to prove the STORED value is not the plaintext.
 */

const ADMIN_TOKEN = "test-admin-token-123";
process.env.ADMIN_TOKEN = ADMIN_TOKEN;

// ---------------------------------------------------------------------------
// In-memory fake Supabase
// ---------------------------------------------------------------------------

interface TenantRow {
  id: string;
  name: string;
  plan_tier: string;
  trial_ends_at: string | null;
  created_at: string;
}

interface CatalogRow {
  module_key: string;
  tier_min: string;
}

interface SubscriptionRow {
  tenant_id: string;
  module_key: string;
  enabled: boolean;
  billing_mode: string;
}

interface BotRow {
  id: string;
  tenant_id: string;
  line_channel_id: string;
  channel_secret_enc: string;
  access_token_enc: string;
  group_reply_mode: string;
  allowed_group_ids: string[];
  default_prefix: string | null;
  active: boolean;
  created_at: string;
}

interface FakeStore {
  tenants: TenantRow[];
  catalog: CatalogRow[];
  subscriptions: SubscriptionRow[];
  bots: BotRow[];
}

// Seeded fresh in beforeEach. The catalog defines each module's minimum tier so the
// route can compute included_in_tier vs addon.
const store: FakeStore = {
  tenants: [],
  catalog: [],
  subscriptions: [],
  bots: [],
};

let tenantSeq = 0;
let botSeq = 0;

function pick<T extends object>(row: T, cols: string): Partial<T> {
  const keys = cols.split(",").map((c) => c.trim());
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (row as Record<string, unknown>)[k];
  return out as Partial<T>;
}

/**
 * A single from(table) builder. It records the pending operation and its selected
 * columns, and is awaitable via .then() so `await sb.from(x).select(y).in(z, w)`
 * resolves to { data, error }. `.single()` returns a promise for the one-row shape.
 */
// Maps the real DB table names the routes call to the fake store's collections.
const TABLE_MAP: Record<string, keyof FakeStore> = {
  upl_tenants: "tenants",
  upl_module_catalog: "catalog",
  upl_module_subscriptions: "subscriptions",
  upl_bots: "bots",
};

function makeBuilder(table: string) {
  let op: "select" | "insert" | null = null;
  let insertPayload: unknown = null;
  let selectCols = "*";
  // Filters captured from .in(); .eq() etc. are not needed by these two routes' POST paths.
  let inFilter: { col: string; values: unknown[] } | null = null;

  function run(): { data: unknown; error: unknown } {
    if (table === "upl_tenants" && op === "insert") {
      const input = insertPayload as { name: string; plan_tier: string };
      tenantSeq += 1;
      const rowFull: TenantRow = {
        id: `tenant-${tenantSeq}`,
        name: input.name,
        plan_tier: input.plan_tier,
        trial_ends_at: null,
        created_at: `2026-01-01T00:00:0${tenantSeq}.000Z`,
      };
      store.tenants.push(rowFull);
      return { data: pick(rowFull, selectCols), error: null };
    }

    if (table === "upl_module_catalog" && op === "select") {
      let rows = store.catalog;
      if (inFilter && inFilter.col === "module_key") {
        rows = rows.filter((r) => inFilter!.values.includes(r.module_key));
      }
      return { data: rows.map((r) => pick(r, selectCols)), error: null };
    }

    if (table === "upl_module_subscriptions" && op === "insert") {
      const rowsIn = insertPayload as SubscriptionRow[];
      for (const r of rowsIn) store.subscriptions.push({ ...r });
      return { data: rowsIn.map((r) => pick(r, selectCols)), error: null };
    }

    if (table === "upl_bots" && op === "insert") {
      const input = insertPayload as Omit<BotRow, "id" | "active" | "created_at">;
      botSeq += 1;
      const rowFull: BotRow = {
        id: `bot-${botSeq}`,
        tenant_id: input.tenant_id,
        line_channel_id: input.line_channel_id,
        channel_secret_enc: input.channel_secret_enc,
        access_token_enc: input.access_token_enc,
        group_reply_mode: input.group_reply_mode,
        allowed_group_ids: input.allowed_group_ids ?? [],
        default_prefix: input.default_prefix ?? null,
        active: true,
        created_at: `2026-02-01T00:00:0${botSeq}.000Z`,
      };
      store.bots.push(rowFull);
      return { data: pick(rowFull, selectCols), error: null };
    }

    throw new Error(`Fake Supabase: unhandled ${op} on "${table}" (cols="${selectCols}")`);
  }

  const builder: Record<string, unknown> = {
    insert(payload: unknown) {
      op = "insert";
      insertPayload = payload;
      return builder;
    },
    select(cols = "*") {
      // For inserts, .select() just narrows returned columns; keep op = insert.
      if (op !== "insert") op = "select";
      selectCols = cols;
      return builder;
    },
    in(col: string, values: unknown[]) {
      inFilter = { col, values };
      return builder;
    },
    single() {
      return Promise.resolve(run());
    },
    // Awaitable: `await sb.from(t).select(c).in(k, v)` resolves to { data, error }.
    then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown) {
      return Promise.resolve(run()).then(onFulfilled);
    },
  };
  return builder;
}

const fakeSupabase = {
  from(table: string) {
    if (!(table in TABLE_MAP)) {
      throw new Error(`Fake Supabase client does not support table "${table}"`);
    }
    return makeBuilder(table);
  },
};

vi.mock("../lib/db", () => ({
  getServiceClient: () => fakeSupabase,
}));

// Import route handlers AFTER the mock is registered so they pick up the fake client.
const { POST: tenantsPOST } = await import("../app/api/admin/tenants/route");
const { POST: botsPOST } = await import("../app/api/admin/bots/route");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock request the route can consume. The handlers only use req.headers.get()
 * and await req.json(), so a plain web Request (cast to the NextRequest param type)
 * is sufficient — no Next.js server runtime needed.
 */
function makeReq(url: string, headers: Record<string, string>, body: unknown): any {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  store.tenants = [];
  store.subscriptions = [];
  store.bots = [];
  // Catalog fixture: starter/pro/business minimum tiers per module.
  store.catalog = [
    { module_key: "assistant_productivity", tier_min: "starter" },
    { module_key: "broadcast", tier_min: "pro" },
    { module_key: "payment_verification", tier_min: "business" },
  ];
  tenantSeq = 0;
  botSeq = 0;
});

// ---------------------------------------------------------------------------
// (1) auth gate
// ---------------------------------------------------------------------------

describe("POST /api/admin/tenants — auth", () => {
  it("returns 401 without the x-admin-token header", async () => {
    const req = makeReq("http://localhost/api/admin/tenants", {}, {
      name: "Acme",
      plan_tier: "pro",
      module_keys: ["assistant_productivity"],
    });

    const res = await tenantsPOST(req);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toEqual({ ok: false, reason: "unauthorized" });
    // Nothing should have been written.
    expect(store.tenants).toHaveLength(0);
    expect(store.subscriptions).toHaveLength(0);
  });

  it("returns 401 with a wrong x-admin-token header", async () => {
    const req = makeReq(
      "http://localhost/api/admin/tenants",
      { "x-admin-token": "WRONG" },
      { name: "Acme", plan_tier: "pro", module_keys: [] }
    );

    const res = await tenantsPOST(req);
    expect(res.status).toBe(401);
    expect(store.tenants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (2) create tenant + subscriptions with billing_mode computed from tier
// ---------------------------------------------------------------------------

describe("POST /api/admin/tenants — create + entitlements", () => {
  it("creates a tenant and inserts one subscription per module_key", async () => {
    const req = makeReq(
      "http://localhost/api/admin/tenants",
      { "x-admin-token": ADMIN_TOKEN },
      {
        name: "Acme Co",
        plan_tier: "pro",
        module_keys: ["assistant_productivity", "broadcast", "payment_verification"],
      }
    );

    const res = await tenantsPOST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.tenant).toMatchObject({ name: "Acme Co", plan_tier: "pro" });
    expect(json.tenant.id).toBeTruthy();

    // One subscription row persisted per unique module_key.
    expect(store.subscriptions).toHaveLength(3);
    expect(json.subscriptions).toHaveLength(3);
    for (const sub of store.subscriptions) {
      expect(sub.tenant_id).toBe(json.tenant.id);
      expect(sub.enabled).toBe(true);
    }
  });

  it("computes billing_mode from module tier_min vs plan_tier (included_in_tier when tier_min <= plan_tier, else addon)", async () => {
    // plan_tier = "pro": starter+pro modules are included; business module is an addon.
    const req = makeReq(
      "http://localhost/api/admin/tenants",
      { "x-admin-token": ADMIN_TOKEN },
      {
        name: "Tier Test",
        plan_tier: "pro",
        module_keys: ["assistant_productivity", "broadcast", "payment_verification"],
      }
    );

    const res = await tenantsPOST(req);
    const json = await res.json();
    expect(res.status).toBe(200);

    const modeByKey = Object.fromEntries(
      (json.subscriptions as Array<{ module_key: string; billing_mode: string }>).map((s) => [
        s.module_key,
        s.billing_mode,
      ])
    );

    // starter module on a pro plan  -> tier_min(starter) <= pro  -> included_in_tier
    expect(modeByKey["assistant_productivity"]).toBe("included_in_tier");
    // pro module on a pro plan       -> tier_min(pro) <= pro      -> included_in_tier
    expect(modeByKey["broadcast"]).toBe("included_in_tier");
    // business module on a pro plan  -> tier_min(business) > pro  -> addon
    expect(modeByKey["payment_verification"]).toBe("addon");

    // Persisted rows agree with the response.
    const persistedByKey = Object.fromEntries(
      store.subscriptions.map((s) => [s.module_key, s.billing_mode])
    );
    expect(persistedByKey).toEqual({
      assistant_productivity: "included_in_tier",
      broadcast: "included_in_tier",
      payment_verification: "addon",
    });
  });

  it("a starter plan treats a pro-min module as an addon", async () => {
    const req = makeReq(
      "http://localhost/api/admin/tenants",
      { "x-admin-token": ADMIN_TOKEN },
      { name: "Starter Co", plan_tier: "starter", module_keys: ["broadcast"] }
    );

    const res = await tenantsPOST(req);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.subscriptions[0]).toMatchObject({
      module_key: "broadcast",
      billing_mode: "addon",
    });
  });
});

// ---------------------------------------------------------------------------
// (3) + (4) bots: encrypt secrets, store channel id as-is, never leak secrets
// ---------------------------------------------------------------------------

describe("POST /api/admin/bots — encrypt secrets & store channel id", () => {
  const PLAINTEXT_SECRET = "line-channel-secret-plaintext";
  const PLAINTEXT_TOKEN = "line-access-token-plaintext";
  const CHANNEL_ID = "Uoabotuserid1234567890";

  function botReq(headers: Record<string, string>) {
    return makeReq("http://localhost/api/admin/bots", headers, {
      tenant_id: "tenant-1",
      line_channel_id: CHANNEL_ID,
      channel_secret: PLAINTEXT_SECRET,
      access_token: PLAINTEXT_TOKEN,
    });
  }

  it("stores channel_secret + access_token ENCRYPTED (stored value is not the plaintext) and keeps line_channel_id verbatim", async () => {
    const res = await botsPOST(botReq({ "x-admin-token": ADMIN_TOKEN }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(store.bots).toHaveLength(1);

    const stored = store.bots[0];

    // line_channel_id persisted exactly as given (it is the LINE `destination` OA Bot User ID).
    expect(stored.line_channel_id).toBe(CHANNEL_ID);

    // Stored secret/token are NOT the plaintext...
    expect(stored.channel_secret_enc).not.toBe(PLAINTEXT_SECRET);
    expect(stored.access_token_enc).not.toBe(PLAINTEXT_TOKEN);
    // ...and the plaintext does not appear anywhere inside the stored ciphertext string.
    expect(stored.channel_secret_enc.includes(PLAINTEXT_SECRET)).toBe(false);
    expect(stored.access_token_enc.includes(PLAINTEXT_TOKEN)).toBe(false);

    // ...but they are recoverable via decrypt() (proves it is real encryption output,
    // not a random/garbled value), round-tripping back to the original plaintext.
    expect(decrypt(stored.channel_secret_enc)).toBe(PLAINTEXT_SECRET);
    expect(decrypt(stored.access_token_enc)).toBe(PLAINTEXT_TOKEN);
  });

  it("response body does NOT leak the secret or token (neither plaintext nor *_enc columns)", async () => {
    const res = await botsPOST(botReq({ "x-admin-token": ADMIN_TOKEN }));
    const json = await res.json();

    expect(res.status).toBe(200);

    // The returned bot object omits secret material entirely.
    expect(json.bot).not.toHaveProperty("channel_secret");
    expect(json.bot).not.toHaveProperty("access_token");
    expect(json.bot).not.toHaveProperty("channel_secret_enc");
    expect(json.bot).not.toHaveProperty("access_token_enc");

    // And no serialization of the whole response contains the plaintext secrets or the
    // stored ciphertext.
    const serialized = JSON.stringify(json);
    expect(serialized.includes(PLAINTEXT_SECRET)).toBe(false);
    expect(serialized.includes(PLAINTEXT_TOKEN)).toBe(false);
    expect(serialized.includes(store.bots[0].channel_secret_enc)).toBe(false);
    expect(serialized.includes(store.bots[0].access_token_enc)).toBe(false);

    // Non-secret fields ARE returned.
    expect(json.bot).toMatchObject({
      tenant_id: "tenant-1",
      line_channel_id: CHANNEL_ID,
      group_reply_mode: "mention_only",
    });
  });

  it("returns 401 without the x-admin-token header and writes nothing", async () => {
    const res = await botsPOST(botReq({}));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toEqual({ ok: false, reason: "unauthorized" });
    expect(store.bots).toHaveLength(0);
  });
});
