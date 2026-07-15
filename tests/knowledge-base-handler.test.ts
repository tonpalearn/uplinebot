import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LineEvent, TenantContext, ModuleConfig } from "../lib/modules/types";

/**
 * Handler-branch tests for the Knowledge Base module, driven through the public ModuleHandler
 * contract (matchesIntent / handleEvent) exactly as the Command Router calls it.
 *
 * The DB boundary (store.ts), the token minter (km-token.ts), and getServiceClient (used by the
 * handler's private loadModuleConfig) are mocked so no Postgres is touched. Answers are plain TEXT
 * messages now (not Flex) — the admin formats them + LINE auto-links URLs.
 */
const {
  mockAddEntry,
  mockSearchKb,
  mockLogUnanswered,
  mockGetOrCreateKmToken,
  mockMatchExactTrigger,
  cfg,
} = vi.hoisted(() => ({
  mockAddEntry: vi.fn(),
  mockSearchKb: vi.fn(),
  mockLogUnanswered: vi.fn(),
  mockGetOrCreateKmToken: vi.fn(),
  mockMatchExactTrigger: vi.fn(),
  cfg: { settings: {} as Record<string, unknown> },
}));

vi.mock("../lib/modules/knowledge-base/store", () => ({
  addEntry: mockAddEntry,
  searchKb: mockSearchKb,
  logUnanswered: mockLogUnanswered,
  matchExactTrigger: mockMatchExactTrigger,
}));

vi.mock("../lib/km-token", () => ({
  getOrCreateKmToken: mockGetOrCreateKmToken,
  kmManageUrl: (token: string) => `https://uplinebot.vercel.app/km/${token}`,
}));

// loadModuleConfig() reads upl_module_configs.settings via getServiceClient; return `cfg.settings`.
vi.mock("../lib/db", () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { settings: cfg.settings }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

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

beforeEach(() => {
  mockAddEntry.mockReset();
  mockSearchKb.mockReset();
  mockLogUnanswered.mockReset();
  mockGetOrCreateKmToken.mockReset();
  mockMatchExactTrigger.mockReset();
  mockMatchExactTrigger.mockResolvedValue(null); // default: no exact trigger hit
  cfg.settings = {}; // default config: exact_trigger on, answer_all off
});

// ── matchesIntent ─────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.matchesIntent", () => {
  const empty: ModuleConfig = {};

  it("matches teach / link / ask commands", () => {
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("สอน a = b"), empty)).toBe(true);
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("คลังความรู้"), empty)).toBe(true);
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("ถาม เปิดกี่โมง"), empty)).toBe(true);
  });

  it("matches ANY text by default (exact_trigger on) — handleEvent stays silent if no trigger hit", () => {
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("สวัสดีครับ"), empty)).toBe(true);
  });

  it("does NOT match ordinary chat when exact_trigger is explicitly off and no answer_all", () => {
    expect(KnowledgeBaseModule.matchesIntent(makeTextEvent("สวัสดีครับ"), { exact_trigger: false })).toBe(false);
  });

  it("matches ANY text when answer_all === true", () => {
    expect(
      KnowledgeBaseModule.matchesIntent(makeTextEvent("ราคาเท่าไหร่"), { answer_all: true, exact_trigger: false })
    ).toBe(true);
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
  it("calls addEntry(tenantId, {question, answer, source:'chat'}) and confirms as text", async () => {
    mockAddEntry.mockResolvedValueOnce({ id: "e1", question: "คืนของได้ไหม", answer: "ได้ภายใน 7 วัน", source: "chat" });

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("สอน คืนของได้ไหม = ได้ภายใน 7 วัน"), baseCtx);

    expect(mockAddEntry).toHaveBeenCalledWith("tenant-1", {
      question: "คืนของได้ไหม",
      answer: "ได้ภายใน 7 วัน",
      source: "chat",
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("✅ จำแล้ว: คืนของได้ไหม");
    expect(mockSearchKb).not.toHaveBeenCalled();
    expect(mockMatchExactTrigger).not.toHaveBeenCalled();
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

// ── exact trigger (no "ถาม" needed) ─────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — exact keyword trigger", () => {
  it("answers directly (plain text) when the message exactly matches a trigger — no ถาม", async () => {
    mockMatchExactTrigger.mockResolvedValueOnce({
      id: "x1",
      question: "opb2026",
      answer: "https://tonpalearn.com/opb2026.html",
      source: "manual",
    });

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("opb2026"), baseCtx);

    expect(mockMatchExactTrigger).toHaveBeenCalledWith("tenant-1", "opb2026");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toBe("https://tonpalearn.com/opb2026.html");
    expect(mockSearchKb).not.toHaveBeenCalled(); // exact hit short-circuits the fuzzy search
  });
});

// ── ask → answer ───────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — ask → answer", () => {
  it("searches the KB and returns the best hit's answer as plain text", async () => {
    mockSearchKb.mockResolvedValueOnce([
      { id: "1", question: "เปิดกี่โมง", answer: "9:00-18:00 ทุกวัน", source: "manual", score: 0.42 },
    ]);

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("ถาม เปิดกี่โมง"), baseCtx);

    expect(mockSearchKb).toHaveBeenCalledWith("tenant-1", "เปิดกี่โมง");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toBe("9:00-18:00 ทุกวัน");
    expect(mockLogUnanswered).not.toHaveBeenCalled();
  });
});

// ── ask → not found ─────────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — ask → not found", () => {
  it("logs the unanswered question (with targetId) and returns the not-found text", async () => {
    mockSearchKb.mockResolvedValueOnce([]);

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("ถาม มีที่จอดรถไหม"), baseCtx);

    expect(mockSearchKb).toHaveBeenCalledWith("tenant-1", "มีที่จอดรถไหม");
    expect(mockLogUnanswered).toHaveBeenCalledWith("tenant-1", "มีที่จอดรถไหม", "target-1");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("ยังไม่มีคำตอบ");
    expect(result[0].text).not.toContain("/km/"); // never leak the manage link on the not-found path
  });
});

// ── answer_all fallback ──────────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — answer_all treats whole text as the question", () => {
  it("searches with the raw text when there is no ถาม/สอน prefix (and no exact hit)", async () => {
    cfg.settings = { answer_all: true };
    mockSearchKb.mockResolvedValueOnce([
      { id: "9", question: "ราคาเท่าไหร่", answer: "เริ่มต้น 990 บาท", source: "manual", score: 0.5 },
    ]);

    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("ราคาเท่าไหร่"), baseCtx);

    expect(mockMatchExactTrigger).toHaveBeenCalledWith("tenant-1", "ราคาเท่าไหร่");
    expect(mockSearchKb).toHaveBeenCalledWith("tenant-1", "ราคาเท่าไหร่");
    expect(result[0].type).toBe("text");
    expect(result[0].text).toBe("เริ่มต้น 990 บาท");
  });
});

// ── plain chatter → silent ───────────────────────────────────────────────────────────────────────
describe("KnowledgeBaseModule.handleEvent — plain chatter stays silent", () => {
  it("returns [] for ordinary text with no exact trigger, no ถาม, and answer_all off", async () => {
    // default: matchExactTrigger → null, cfg.settings = {} (answer_all off)
    const result = await KnowledgeBaseModule.handleEvent(makeTextEvent("สวัสดีครับ อยากสอบถามหน่อย"), baseCtx);

    expect(mockMatchExactTrigger).toHaveBeenCalled();
    expect(mockSearchKb).not.toHaveBeenCalled();
    expect(result).toEqual([]); // silent → staff can chat manually without the bot butting in
  });
});
