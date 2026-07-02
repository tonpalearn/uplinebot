import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

import { verifyLineSignature } from "../lib/line/verify";
import type { LineEvent, TenantContext } from "../lib/modules/types";

/**
 * ---------------------------------------------------------------------------
 * Mock Supabase (lib/db.ts) — routeEvent(), entitlement checks, and the Slip
 * Verification handler all go through getServiceClient(). We stub a minimal
 * chainable query builder covering the tables these paths touch:
 *   - upl_module_subscriptions (entitlement checks)
 *   - upl_module_configs       (per-module settings, loaded by the router)
 *   - upl_bots                 (slip handler: bot access token)
 *   - upl_slip_verifications   (slip handler: dedupe insert)
 *
 * Behavior for each table is configurable per-test via `dbState`.
 * ---------------------------------------------------------------------------
 */

interface DbState {
  // module_key -> enabled
  subscriptions: Record<string, boolean>;
  // module_key -> settings
  configs: Record<string, Record<string, unknown>>;
  // whether the slip insert should succeed (and what error, if any)
  slipInsert: { error: { code?: string; message: string } | null };
}

let dbState: DbState;

function makeQueryBuilder(table: string) {
  const filters: Record<string, unknown> = {};

  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn((col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    }),
    insert: vi.fn((_row: unknown) => builder),
    maybeSingle: vi.fn(async () => {
      if (table === "upl_module_subscriptions") {
        const moduleKey = filters["module_key"] as string;
        const enabled = dbState.subscriptions[moduleKey] ?? false;
        return { data: { enabled }, error: null };
      }
      if (table === "upl_module_configs") {
        const moduleKey = filters["module_key"] as string;
        const settings = dbState.configs[moduleKey] ?? {};
        return { data: { settings }, error: null };
      }
      return { data: null, error: null };
    }),
    single: vi.fn(async () => {
      if (table === "upl_bots") {
        return { data: { access_token_enc: Buffer.from("token").toString("base64") }, error: null };
      }
      if (table === "upl_slip_verifications") {
        if (dbState.slipInsert.error) {
          return { data: null, error: dbState.slipInsert.error };
        }
        return { data: { id: "slip-row-1" }, error: null };
      }
      return { data: null, error: null };
    }),
  };

  return builder;
}

vi.mock("../lib/db", () => ({
  getServiceClient: () => ({
    from: (table: string) => makeQueryBuilder(table),
  }),
}));

// Slip handler decrypts the stored access token via lib/crypto — stub it so we
// don't depend on ENCRYPTION_KEY behavior for this pipeline test.
vi.mock("../lib/crypto", () => ({
  decrypt: (buf: Buffer) => buf.toString("utf8"),
}));

// Import AFTER the mocks above so the modules under test pick up the mocked db/crypto.
const { routeEvent } = await import("../lib/modules/registry");
const { assertModuleEntitled, EntitlementError } = await import("../lib/entitlement");

function baseCtx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: "tenant-1",
    targetId: "target-1",
    botId: "bot-1",
    sourceType: "group",
    ...overrides,
  };
}

function textEvent(text: string, overrides: Partial<LineEvent> = {}): LineEvent {
  return {
    type: "message",
    message: { id: "msg-1", type: "text", text },
    replyToken: "reply-1",
    source: { type: "group", groupId: "group-1" },
    timestamp: Date.now(),
    ...overrides,
  };
}

function imageEvent(overrides: Partial<LineEvent> = {}): LineEvent {
  return {
    type: "message",
    message: { id: "msg-img-1", type: "image" },
    replyToken: "reply-2",
    source: { type: "group", groupId: "group-1" },
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  dbState = {
    subscriptions: {},
    configs: {},
    slipInsert: { error: null },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. LINE signature verification
// ---------------------------------------------------------------------------
describe("verifyLineSignature", () => {
  const channelSecret = "test_channel_secret_abc123";
  const rawBody = JSON.stringify({ events: [{ type: "message" }] });

  function computeSignature(body: string, secret: string): string {
    return createHmac("sha256", secret).update(body).digest("base64");
  }

  it("accepts a correctly computed signature", () => {
    const goodSignature = computeSignature(rawBody, channelSecret);
    expect(verifyLineSignature(rawBody, goodSignature, channelSecret)).toBe(true);
  });

  it("rejects a tampered signature (wrong value, same length)", () => {
    const goodSignature = computeSignature(rawBody, channelSecret);
    // flip one character but keep the same base64 length
    const tamperedChar = goodSignature[0] === "A" ? "B" : "A";
    const tampered = tamperedChar + goodSignature.slice(1);
    expect(verifyLineSignature(rawBody, tampered, channelSecret)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const badSignature = computeSignature(rawBody, "wrong_secret");
    expect(verifyLineSignature(rawBody, badSignature, channelSecret)).toBe(false);
  });

  it("rejects when the body has been tampered with (signature stale)", () => {
    const goodSignature = computeSignature(rawBody, channelSecret);
    const tamperedBody = JSON.stringify({ events: [{ type: "message", injected: true }] });
    expect(verifyLineSignature(tamperedBody, goodSignature, channelSecret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyLineSignature(rawBody, null, channelSecret)).toBe(false);
    expect(verifyLineSignature(rawBody, undefined, channelSecret)).toBe(false);
    expect(verifyLineSignature(rawBody, "", channelSecret)).toBe(false);
  });

  it("rejects when channelSecret is empty", () => {
    const goodSignature = computeSignature(rawBody, channelSecret);
    expect(verifyLineSignature(rawBody, goodSignature, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Mention-only mode silence
// ---------------------------------------------------------------------------
describe("routeEvent — mention-only group silence", () => {
  it("returns no messages (silent, no crash) when text doesn't mention the bot or match any keyword", async () => {
    dbState.subscriptions = {
      assistant_productivity: true,
      broadcast_campaigns: true,
      slip_verification: true,
    };

    const event = textEvent("สวัสดีครับวันนี้อากาศดีจัง"); // plain chat, no keyword, no mention
    const ctx = baseCtx();

    const result = await routeEvent(event, ctx);

    expect(result).toEqual([]);
  });

  it("still returns no messages even when every module is entitled and text is conversational", async () => {
    dbState.subscriptions = {
      assistant_productivity: true,
      broadcast_campaigns: true,
      slip_verification: true,
    };
    dbState.configs = {
      assistant_productivity: { group_reply_mode: "mention_only" },
    };

    const event = textEvent("มีใครกินข้าวหรือยัง");
    const ctx = baseCtx();

    await expect(routeEvent(event, ctx)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Priority order — Slip Verification checked before keyword modules
// ---------------------------------------------------------------------------
describe("routeEvent — router priority order (SYSTEM-DESIGN.md §4.2)", () => {
  it("checks Slip Verification before keyword modules for image messages", async () => {
    dbState.subscriptions = {
      slip_verification: true,
      assistant_productivity: true,
      broadcast_campaigns: true,
    };

    const event = imageEvent();
    const ctx = baseCtx();

    const result = await routeEvent(event, ctx);

    // Slip Verification's handleEvent ran (mock provider marker byte 0x01 => valid),
    // proving the image event was routed to slip_verification, not silently
    // falling through since assistant_productivity/broadcast never match images anyway.
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("ยืนยันสลิปสำเร็จ");
  });

  it("consults entitlement for slip_verification strictly before assistant_productivity", async () => {
    dbState.subscriptions = {
      slip_verification: true,
      assistant_productivity: true,
      broadcast_campaigns: true,
    };

    const seenOrder: string[] = [];
    const entitlementModule = await import("../lib/entitlement");
    const spy = vi.spyOn(entitlementModule, "isModuleEntitled");
    spy.mockImplementation(async (_tenantId: string, moduleKey: string) => {
      seenOrder.push(moduleKey);
      return dbState.subscriptions[moduleKey] ?? false;
    });

    const event = imageEvent();
    const ctx = baseCtx();

    await routeEvent(event, ctx);

    expect(seenOrder[0]).toBe("slip_verification");
    expect(seenOrder.indexOf("slip_verification")).toBeLessThan(
      seenOrder.indexOf("assistant_productivity") === -1
        ? Infinity
        : seenOrder.indexOf("assistant_productivity")
    );

    spy.mockRestore();
  });

  it("falls through to assistant_productivity keyword match when the event is text, not image", async () => {
    dbState.subscriptions = {
      slip_verification: true,
      assistant_productivity: true,
      broadcast_campaigns: true,
    };

    const event = textEvent("นัดหมาย ประชุมทีมพรุ่งนี้");
    const ctx = baseCtx();

    const result = await routeEvent(event, ctx);

    // slip_verification.matchesIntent() is false for non-image events, so the
    // router proceeds to assistant_productivity per priority order.
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Entitlement guard — assertModuleEntitled throws when module not enabled
// ---------------------------------------------------------------------------
describe("assertModuleEntitled", () => {
  it("throws EntitlementError when the module is not enabled for the tenant", async () => {
    dbState.subscriptions = {
      slip_verification: false,
    };

    await expect(assertModuleEntitled("tenant-1", "slip_verification")).rejects.toThrow(
      EntitlementError
    );
    await expect(assertModuleEntitled("tenant-1", "slip_verification")).rejects.toThrow(
      /not enabled for this tenant/
    );
  });

  it("resolves without throwing when the module is enabled", async () => {
    dbState.subscriptions = {
      assistant_productivity: true,
    };

    await expect(assertModuleEntitled("tenant-1", "assistant_productivity")).resolves.toBeUndefined();
  });

  it("throws EntitlementError (not a generic error) so callers can distinguish it from real failures", async () => {
    dbState.subscriptions = {}; // module row doesn't exist / not enabled

    try {
      await assertModuleEntitled("tenant-1", "broadcast_campaigns");
      expect.unreachable("assertModuleEntitled should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EntitlementError);
      expect((err as InstanceType<typeof EntitlementError>).moduleKey).toBe("broadcast_campaigns");
    }
  });
});
