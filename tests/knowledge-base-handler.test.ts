import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LineEvent, TenantContext, ModuleConfig, OutboundMessage } from "../lib/modules/types";

/**
 * Handler-branch tests for the Knowledge Base module, driven through the public ModuleHandler
 * contract (matchesIntent / handleEvent) exactly as the Command Router calls it.
 *
 * The DB boundary (lib/modules/knowledge-base/store.ts) and the token minter (lib/km-token.ts)
 * are mocked so no Postgres/Supabase is touched — we assert the handler wires the RIGHT store
 * call to the RIGHT branch and renders the RIGHT card. The Flex/text builders (flex.ts) run for
 * real so the output shape is exercised end-to-end.
 */
// vi.hoisted() so these exist before the hoisted vi.mock factories (and the handler's ES imports,
// which are hoisted above plain `const`s) reference them — otherwise the factory runs first and
// hits a temporal-dead-zone ReferenceError.
const { mockAddEntry, mockSearchKb, mockLogUnanswered, mockGetOrCreateKmToken } = vi.hoisted(() => ({
  mockAddEntry: vi.fn(),
  mockSearchKb: vi.fn(),
  mockLogUnanswered: vi.fn(),
  mockGetOrCreateKmToken: vi.fn(),
}));

vi.mock("../lib/modules/knowledge-base/store", () => ({
  addEntry: mockAddEntry,
  searchKb: mockSearchKb,
  logUnanswered: mockLogUnanswered,
}));

vi.mock("../lib/km-token", () => ({
  getOrCreateKmToken: mockGetOrCreateKmToken,
  kmManageUrl: (token: string) => `https://uplinebot.vercel.app/km/${token}`,
}));

// Import after the mocks so the handler picks up the mocked modules.
import { KnowledgeBaseModule } from "../lib/modules/knowledge-base/handler";

const baseCtx: TenantContext = {
  tenantId: "tenant-1",
  targetId: "target-1",
  botId: "bot-1",
  sourceType: "user",
};

function makeTextEvent(text: string): LineEvent {
  return {
    type: "message",
    message: { id: "msg-1", type: "text", text },
    replyToken: "reply-token-1",
    source: { type: "user", userId: "user-1" },
    timestamp: Date.now(),
  };
}

function asString(contents: unknown): string {
  return JSON.stringify(contents);
}

beforeEach(() => {
  mockAddEntry.mockReset();
  mockSearchKb.mockReset();
  mockLogUnanswered.mockReset();
  mockGetOrCreateKmToken.mockReset();
});

// ── matchesIntent ─────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.matchesIntent", () => {
  const empty: ModuleConfig = {};

  it("matches teach / link / ask commands (default config)", () => {
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("สอน a = b"), empty)).toBe(true);
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("คลังความรู้"), empty)).toBe(true);
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("ถาม เปิดกี่โมง"), empty)).toBe(true);
  });

  it("does NOT match ordinary chat by default", () => {
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("สวัสดีครับ"), empty)).toBe(false);
  });

  it("matches ANY text when config.answer_all === true", () => {
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("ราคาเท่าไหร่"), { answer_all: true })).toBe(true);
  });

  it("never matches non-text events", () => {
    const sticker: LineEvent = {
      type: "message",
      message: { id: "m", type: "sticker" },
      source: { type: "user", userId: "u" },
      timestamp: Date.now(),
    };
    expect(KnowledgeBaseModule.matchesIntent(sticker, { answer_all: true })).toBe(false);
  });
});

// ── teach ────────────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — teach", () => {
  it("calls addEntry(tenantId, {question, answer, source:'chat'}) and confirms", async () => {
    mockAddEntry.mockResolvedValueOnce({
      id: "e1",
      question: "คืนของได้ไหม",
      answer: "ได้ภายใน 7 วัน",
      source: "chat",
    });

    const result = await KnowledgeBaseModule.handleEvent(
      makeTextEvent("สอน คืนของได้ไหม = ได้ภายใน 7 วัน"),
      baseCtx
    );

    expect(mockAddEntry).toHaveBeenCalledWith("tenant-1", {
      question: "คืนของได้ไหม",
      answer: "ได้ภายใน 7 วัน",
      source: "chat",
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("✅ จำแล้ว: คืนของได้ไหม");
    expect(mockSearchKb).not.toHaveBeenCalled();
  });
});

// ── link ─────────────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — link", () => {
  it("mints/reads the tenant km token and returns the manage URL", async () => {
    mockGetOrCreateKmToken.mockResolvedValueOnce("TOKEN123");

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("คลังความรู้"), baseCtx);

    expect(mockGetOrCreateKmToken).toHaveBeenCalledWith("tenant-1");
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("https://uplinebot.vercel.app/km/TOKEN123");
  });
});

// ── ask → answer ───────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — ask → answer", () => {
  it("searches the KB and returns a Flex answer card for the best hit", async () => {
    mockSearchKb.mockResolvedValueOnce([
      { id: "1", question: "เปิดกี่โมง", answer: "9:00-18:00 ทุกวัน", source: "manual", score: 0.42 },
      { id: "2", question: "หยุดวันไหน", answer: "ไม่มีวันหยุด", source: "manual", score: 0.2 },
    ]);

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("ถาม เปิดกี่โมง"), baseCtx);

    expect(mockSearchKb).toHaveBeenCalledWith("tenant-1", "เปิดกี่โมง");
    expect(result).toHaveLength(1);
    const msg = result[0] as OutboundMessage;
    expect(msg.type).toBe("flex");
    const body = asString(msg.contents);
    expect(body).toContain("เปิดกี่โมง");
    expect(body).toContain("9:00-18:00 ทุกวัน");
    // the 2nd hit becomes a "ถามต่อ" quick-reply chip
    expect(JSON.stringify(msg.quickReply)).toContain("ถาม หยุดวันไหน");
    expect(mockLogUnanswered).not.toHaveBeenCalled();
  });
});

// ── ask → not found ─────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — ask → not found", () => {
  it("logs the unanswered question (with targetId) and returns the not-found card", async () => {
    mockSearchKb.mockResolvedValueOnce([]);

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("ถาม มีที่จอดรถไหม"), baseCtx);

    expect(mockSearchKb).toHaveBeenCalledWith("tenant-1", "มีที่จอดรถไหม");
    expect(mockLogUnanswered).toHaveBeenCalledWith("tenant-1", "มีที่จอดรถไหม", "target-1");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("flex");
    expect(result[0].altText).toContain("ยังไม่มีคำตอบ");
    // never leak the tenant-wide manage link to an end user on the not-found path
    expect(asString(result[0].contents)).not.toContain("/km/");
  });
});

// ── answer_all fallback ──────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — answer_all treats whole text as the question", () => {
  it("searches with the raw text when there is no ถาม/สอน/link prefix", async () => {
    mockSearchKb.mockResolvedValueOnce([
      { id: "9", question: "ราคาเท่าไหร่", answer: "เริ่มต้น 990 บาท", source: "manual", score: 0.5 },
    ]);

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("ราคาเท่าไหร่"), baseCtx);

    expect(mockSearchKb).toHaveBeenCalledWith("tenant-1", "ราคาเท่าไหร่");
    expect(result[0].type).toBe("flex");
    expect(asString(result[0].contents)).toContain("เริ่มต้น 990 บาท");
  });
});
