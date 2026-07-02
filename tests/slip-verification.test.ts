import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LineEvent, TenantContext } from "../lib/modules/types";

/**
 * Tests for lib/modules/slip-verification/handler.ts using MockSlipProvider
 * (SLIP_PROVIDER=mock, set globally in tests/setup.ts).
 *
 * Strategy:
 * - lib/db.ts's getServiceClient() is mocked so no live Supabase instance is
 *   required. The fake client supports the two tables the handler touches:
 *     - upl_module_subscriptions (entitlement check, via .maybeSingle())
 *     - upl_slip_verifications   (insert + dedupe, via .insert().select().single())
 * - lib/line/client.ts's getMessageContent() is mocked per-test so we can control
 *   the raw image bytes fed into MockSlipProvider (whose first byte is the
 *   valid/invalid marker — see providers/mock.ts).
 * - lib/crypto.ts's decrypt() is mocked to a no-op since bot access token lookups
 *   go through getServiceClient() too (routed to a generic table stub).
 */

const insertMock = vi.fn();
let duplicateOnNextInsert = false;

vi.mock("../lib/db", () => {
  return {
    getServiceClient: () => ({
      from(table: string) {
        if (table === "upl_module_subscriptions") {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            maybeSingle: async () => ({ data: { enabled: true }, error: null }),
          };
        }

        if (table === "upl_slip_verifications") {
          return {
            insert(row: Record<string, unknown>) {
              insertMock(row);
              return {
                select() {
                  return this;
                },
                single: async () => {
                  if (duplicateOnNextInsert) {
                    return {
                      data: null,
                      error: { code: "23505", message: "duplicate key value violates unique constraint" },
                    };
                  }
                  return { data: { id: "fake-id" }, error: null };
                },
              };
            },
          };
        }

        // upl_bots (access token lookup) and anything else — generic single-row stub.
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          single: async () => ({ data: { access_token_enc: Buffer.from("unused") }, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    }),
  };
});

vi.mock("../lib/crypto", () => ({
  decrypt: () => "test-access-token",
  encrypt: (v: string) => Buffer.from(v),
  isUsingStubEncryption: () => true,
}));

const getMessageContentMock = vi.fn();

vi.mock("../lib/line/client", async () => {
  const actual = await vi.importActual<typeof import("../lib/line/client")>("../lib/line/client");
  return {
    ...actual,
    getMessageContent: (...args: unknown[]) => getMessageContentMock(...args),
  };
});

import { SlipVerificationModule } from "../lib/modules/slip-verification/handler";

function makeImageEvent(messageId = "msg-1"): LineEvent {
  return {
    type: "message",
    message: { id: messageId, type: "image" },
    replyToken: "reply-token-1",
    source: { type: "user", userId: "user-1" },
    timestamp: Date.now(),
  };
}

function makeCtx(): TenantContext {
  return {
    tenantId: "tenant-1",
    targetId: "target-1",
    botId: "bot-1",
    sourceType: "user",
  };
}

describe("SlipVerificationModule (MockSlipProvider, SLIP_PROVIDER=mock)", () => {
  beforeEach(() => {
    insertMock.mockClear();
    getMessageContentMock.mockReset();
    duplicateOnNextInsert = false;
    expect(process.env.SLIP_PROVIDER).toBe("mock");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matchesIntent() is true only for image messages", () => {
    const imageEvent = makeImageEvent();
    const textEvent: LineEvent = {
      type: "message",
      message: { id: "msg-text", type: "text", text: "hello" },
      source: { type: "user", userId: "user-1" },
      timestamp: Date.now(),
    };

    expect(SlipVerificationModule.matchesIntent(imageEvent, {})).toBe(true);
    expect(SlipVerificationModule.matchesIntent(textEvent, {})).toBe(false);
  });

  it("1. a valid slip image produces a verified status and a confirmation reply", async () => {
    // Marker byte 0x01 = valid slip per MockSlipProvider convention.
    getMessageContentMock.mockResolvedValue(Buffer.from([0x01, 0xaa, 0xbb, 0xcc]));

    const messages = await SlipVerificationModule.handleEvent(makeImageEvent(), makeCtx());

    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertedRow = insertMock.mock.calls[0][0];
    expect(insertedRow.status).toBe("verified");
    expect(insertedRow.provider).toBe("mock");

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("text");
    expect(messages[0].text).toContain("ยืนยันสลิปสำเร็จ");
    expect(messages[0].text).toContain("✅");
  });

  it("2. submitting the same slip twice produces a duplicate status on the second attempt", async () => {
    // Same buffer both times -> same slip_ref_hash -> second insert simulates a
    // Postgres unique-violation (23505) on (tenant_id, slip_ref_hash).
    const slipBuffer = Buffer.from([0x01, 0x10, 0x20, 0x30]);
    getMessageContentMock.mockResolvedValue(slipBuffer);

    const firstAttempt = await SlipVerificationModule.handleEvent(makeImageEvent("msg-first"), makeCtx());
    expect(firstAttempt[0].text).toContain("ยืนยันสลิปสำเร็จ");

    duplicateOnNextInsert = true;

    const secondAttempt = await SlipVerificationModule.handleEvent(makeImageEvent("msg-second"), makeCtx());

    expect(insertMock).toHaveBeenCalledTimes(2);
    // Both inserts computed the same slip_ref_hash since the underlying slip data matches.
    const firstHash = insertMock.mock.calls[0][0].slip_ref_hash;
    const secondHash = insertMock.mock.calls[1][0].slip_ref_hash;
    expect(secondHash).toBe(firstHash);

    expect(secondAttempt).toHaveLength(1);
    expect(secondAttempt[0].type).toBe("text");
    expect(secondAttempt[0].text).toContain("ถูกใช้ยืนยันไปแล้ว");
    expect(secondAttempt[0].text).toContain("⚠️");
  });

  it("3. an invalid/fake slip produces a fraud-alert style reply", async () => {
    // Any marker byte other than 0x01 = invalid slip per MockSlipProvider convention.
    getMessageContentMock.mockResolvedValue(Buffer.from([0x00, 0xde, 0xad, 0xbe]));

    const messages = await SlipVerificationModule.handleEvent(makeImageEvent(), makeCtx());

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0].status).toBe("failed");

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("text");
    expect(messages[0].text).toContain("❌");
    expect(messages[0].text).toContain("ไม่สามารถยืนยันสลิปนี้ได้");
  });

  it("4. a provider timeout falls back to the in-progress message within the 3s budget", async () => {
    vi.useFakeTimers();

    getMessageContentMock.mockResolvedValue(Buffer.from([0x01, 0x01, 0x01, 0x01]));

    // The handler resolves the provider internally (SLIP_PROVIDER=mock -> MockSlipProvider),
    // so to exercise the timeout branch we make verify() on the prototype hang
    // deliberately longer than PROVIDER_TIMEOUT_MS (3000ms) baked into handler.ts.
    const { MockSlipProvider } = await import("../lib/modules/slip-verification/providers/mock");
    const verifySpy = vi
      .spyOn(MockSlipProvider.prototype, "verify")
      .mockImplementation(() => new Promise(() => {})); // never resolves — forces the race to hit the timeout

    const handlePromise = SlipVerificationModule.handleEvent(makeImageEvent(), makeCtx());

    // Advance exactly to (and past) the 3000ms PROVIDER_TIMEOUT_MS budget baked
    // into verifyWithTimeout() in handler.ts.
    await vi.advanceTimersByTimeAsync(3000);

    const messages = await handlePromise;

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("text");
    expect(messages[0].text).toContain("กำลังตรวจสอบสลิป");
    // Timeout path returns before any DB insert is attempted.
    expect(insertMock).not.toHaveBeenCalled();

    verifySpy.mockRestore();
  });
});
