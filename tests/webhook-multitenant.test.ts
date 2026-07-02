import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

/**
 * THE core sell-model test: ONE webhook URL serves MANY customers.
 *
 * Each inbound LINE webhook carries a `destination` (the bot's own user id).
 * The handler must:
 *   1. Resolve which bot/tenant that destination belongs to (upl_bots.line_channel_id).
 *   2. Verify X-Line-Signature against THAT bot's OWN channel secret (per-channel HMAC).
 *   3. Reject when the destination matches no bot (404) or the signature is wrong (401).
 *
 * We stand up TWO bots in a fake `upl_bots` table (A -> tenant TA, B -> tenant TB), each
 * with its own encrypted channel secret + access token, and compute a REAL HMAC-SHA256
 * base64 signature over the raw body with the correct per-bot secret so the assertions are
 * honest (the production verifyLineSignature is real crypto and is NOT mocked here).
 */

// ---------------------------------------------------------------------------
// Fixtures: two tenants, two bots, each with its own secret.
// ---------------------------------------------------------------------------
const BOT_A = {
  id: "bot-A-id",
  tenant_id: "TA",
  line_channel_id: "Udestinationaaa",
  channel_secret: "secret-A-aaaaaaaaaaaaaaaaaaaa",
  access_token: "access-token-A",
  active: true,
};
const BOT_B = {
  id: "bot-B-id",
  tenant_id: "TB",
  line_channel_id: "Udestinationbbb",
  channel_secret: "secret-B-bbbbbbbbbbbbbbbbbbbb",
  access_token: "access-token-B",
  active: true,
};

// Encrypted-at-rest form the fake DB returns for the *_enc columns. The mocked
// decrypt() (below) reverses this `enc:` prefix to recover the plaintext secret,
// mirroring how the real handler round-trips channel_secret_enc through decrypt().
const encOf = (plain: string) => `enc:${plain}`;

const BOTS = [BOT_A, BOT_B];

// Records every line_channel_id passed to the bot-by-destination lookup, so a test
// can assert that a destination-B body actually drove a destination-B lookup.
const channelIdLookups: string[] = [];

// ---------------------------------------------------------------------------
// Mock lib/db getServiceClient — a tiny in-memory Supabase query builder that
// serves the three tables the webhook path touches:
//   - upl_bots  (by line_channel_id+active, and by id)
//   - upl_targets (resolveContext; we always return an existing target row)
// The builder collects .eq() filters and resolves them against BOTS on
// .maybeSingle()/.single().
// ---------------------------------------------------------------------------
vi.mock("../lib/db", () => {
  function makeQuery(table: string) {
    const filters: Record<string, unknown> = {};
    let selectedCols = "";

    const resolveRow = () => {
      if (table === "upl_bots") {
        if ("line_channel_id" in filters) {
          channelIdLookups.push(String(filters.line_channel_id));
          const row = BOTS.find(
            (b) =>
              b.line_channel_id === filters.line_channel_id &&
              (!("active" in filters) || b.active === filters.active)
          );
          if (!row) return { data: null, error: null };
          return { data: { id: row.id, tenant_id: row.tenant_id }, error: null };
        }
        if ("id" in filters) {
          const row = BOTS.find((b) => b.id === filters.id);
          if (!row) return { data: null, error: null };
          // Return only the column(s) the caller selected.
          const data: Record<string, unknown> = {};
          if (selectedCols.includes("channel_secret_enc")) {
            data.channel_secret_enc = encOf(row.channel_secret);
          }
          if (selectedCols.includes("access_token_enc")) {
            data.access_token_enc = encOf(row.access_token);
          }
          return { data, error: null };
        }
        return { data: null, error: null };
      }

      if (table === "upl_targets") {
        // Pretend this (bot, source) already has a target row so resolveContext
        // takes the existing-row branch and never needs to INSERT.
        return { data: { id: "target-existing" }, error: null };
      }

      return { data: null, error: null };
    };

    const builder: Record<string, unknown> = {
      select: (cols: string) => {
        selectedCols = cols ?? "";
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      maybeSingle: async () => resolveRow(),
      single: async () => resolveRow(),
    };
    return builder;
  }

  return {
    getServiceClient: () => ({
      from: (table: string) => makeQuery(table),
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock lib/crypto decrypt — reverse the `enc:` prefix to a known per-bot secret.
// ---------------------------------------------------------------------------
vi.mock("../lib/crypto", () => ({
  decrypt: (value: string) => (value.startsWith("enc:") ? value.slice("enc:".length) : value),
}));

// ---------------------------------------------------------------------------
// Mock the Command Router and the LINE Sender so a verified request does not
// reach real module logic or the network. Spies let us assert routing happened.
// ---------------------------------------------------------------------------
const routeEventMock = vi.fn(async (..._args: any[]) => [{ type: "text", text: "ok" }]);
vi.mock("../lib/modules/registry", () => ({
  routeEvent: (...args: unknown[]) => routeEventMock(...args),
}));

const replyMessageMock = vi.fn(async (..._args: any[]) => ({ ok: true, status: 200 }));
vi.mock("../lib/line/client", () => ({
  replyMessage: (...args: unknown[]) => replyMessageMock(...args),
}));

// Import the handler AFTER the mocks so it binds to the mocked modules.
import { POST } from "../app/api/line/webhook/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function webhookBody(destination: string): string {
  return JSON.stringify({
    destination,
    events: [
      {
        type: "message",
        message: { id: "m1", type: "text", text: "hello" },
        replyToken: "reply-token-xyz",
        source: { type: "user", userId: "Uenduser0001" },
        timestamp: 1_700_000_000_000,
      },
    ],
  });
}

/** Real LINE-style signature: base64(HMAC-SHA256(channelSecret, rawBody)). */
function sign(rawBody: string, channelSecret: string): string {
  return createHmac("sha256", channelSecret).update(rawBody).digest("base64");
}

function makeRequest(rawBody: string, signature: string | null): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("x-line-signature", signature);
  return new NextRequest("https://up-line.example.com/api/line/webhook", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

beforeEach(() => {
  routeEventMock.mockClear();
  replyMessageMock.mockClear();
  channelIdLookups.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /api/line/webhook — multi-tenant routing by destination + per-channel signature", () => {
  it("(1) destination A + valid signature (bot A secret) -> 200 and routes as tenant TA", async () => {
    const raw = webhookBody(BOT_A.line_channel_id);
    const res = await POST(makeRequest(raw, sign(raw, BOT_A.channel_secret)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The lookup was driven by destination A.
    expect(channelIdLookups).toContain(BOT_A.line_channel_id);

    // The event was routed with tenant TA / bot A context.
    expect(routeEventMock).toHaveBeenCalledTimes(1);
    const ctx = routeEventMock.mock.calls[0][1] as { tenantId: string; botId: string };
    expect(ctx.tenantId).toBe("TA");
    expect(ctx.botId).toBe(BOT_A.id);

    // Reply went out with bot A's decrypted access token.
    expect(replyMessageMock).toHaveBeenCalledTimes(1);
    expect(replyMessageMock.mock.calls[0][0]).toBe(BOT_A.access_token);
  });

  it("(2) destination A + signature computed with the WRONG secret -> 401 invalid_signature", async () => {
    const raw = webhookBody(BOT_A.line_channel_id);
    // Sign with bot B's secret (or any wrong secret) against a body destined for A.
    const res = await POST(makeRequest(raw, sign(raw, BOT_B.channel_secret)));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_signature" });

    // Rejected before any routing / reply happened.
    expect(routeEventMock).not.toHaveBeenCalled();
    expect(replyMessageMock).not.toHaveBeenCalled();
  });

  it("(3) destination matching no bot -> 404 unknown_bot", async () => {
    const raw = webhookBody("Uno-such-destination");
    // Even a signature that is 'valid' for some secret cannot save an unknown destination,
    // because the bot (and thus the secret to verify against) can't be resolved at all.
    const res = await POST(makeRequest(raw, sign(raw, "whatever-secret")));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, reason: "unknown_bot" });

    expect(channelIdLookups).toContain("Uno-such-destination");
    expect(routeEventMock).not.toHaveBeenCalled();
    expect(replyMessageMock).not.toHaveBeenCalled();
  });

  it("(4) destination B + valid signature (bot B secret) -> 200, lookup used destination B, routes as tenant TB", async () => {
    const raw = webhookBody(BOT_B.line_channel_id);
    const res = await POST(makeRequest(raw, sign(raw, BOT_B.channel_secret)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The bot lookup was performed against destination B specifically.
    expect(channelIdLookups).toContain(BOT_B.line_channel_id);
    expect(channelIdLookups).not.toContain(BOT_A.line_channel_id);

    // Routed with tenant TB / bot B, and replied with bot B's access token.
    expect(routeEventMock).toHaveBeenCalledTimes(1);
    const ctx = routeEventMock.mock.calls[0][1] as { tenantId: string; botId: string };
    expect(ctx.tenantId).toBe("TB");
    expect(ctx.botId).toBe(BOT_B.id);
    expect(replyMessageMock.mock.calls[0][0]).toBe(BOT_B.access_token);
  });

  it("(bonus) a signature valid for bot A but sent to destination B is rejected 401 (secrets are not interchangeable)", async () => {
    const raw = webhookBody(BOT_B.line_channel_id);
    // Correctly-formed HMAC, but with the WRONG tenant's secret.
    const res = await POST(makeRequest(raw, sign(raw, BOT_A.channel_secret)));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_signature" });
    expect(routeEventMock).not.toHaveBeenCalled();
  });
});
