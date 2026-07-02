import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LineEvent, ScheduledJob, TenantContext, ModuleConfig } from "../lib/modules/types";

/**
 * Mocks the Supabase client boundary (lib/db.ts) so the broadcast handler's
 * loadModuleConfig()/loadBroadcastById() calls never hit a live database.
 * Each test configures the chained `.from().select().eq()...` builder to
 * resolve with whatever row it needs via `mockMaybeSingle`.
 */
const mockMaybeSingle = vi.fn();

vi.mock("../lib/db", () => {
  return {
    getServiceClient: () => ({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: mockMaybeSingle,
            })),
            maybeSingle: mockMaybeSingle,
          })),
        })),
      })),
    }),
  };
});

// Import after the mock so BroadcastModule picks up the mocked lib/db module.
import { BroadcastModule } from "../lib/modules/broadcast/handler";

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
  mockMaybeSingle.mockReset();
});

describe("BroadcastModule — trigger keyword auto-reply", () => {
  const config: ModuleConfig = {
    trigger_keyword: "โปรโมชั่น",
    trigger_reply_text: "รับส่วนลด 20% วันนี้เท่านั้น!",
  };

  it("matchesIntent() returns true and handleEvent() returns the configured reply text on an exact keyword match", async () => {
    expect(BroadcastModule.matchesIntent(makeTextEvent("โปรโมชั่น"), config)).toBe(true);

    // handleEvent reloads config itself via ctx.targetId — stub the DB read.
    mockMaybeSingle.mockResolvedValueOnce({ data: { settings: config }, error: null });

    const result = await BroadcastModule.handleEvent(makeTextEvent("โปรโมชั่น"), baseCtx);

    expect(result).toEqual([{ type: "text", text: "รับส่วนลด 20% วันนี้เท่านั้น!" }]);
  });

  it("tolerates surrounding whitespace on an otherwise exact keyword match", async () => {
    expect(BroadcastModule.matchesIntent(makeTextEvent("  โปรโมชั่น  "), config)).toBe(true);

    mockMaybeSingle.mockResolvedValueOnce({ data: { settings: config }, error: null });
    const result = await BroadcastModule.handleEvent(makeTextEvent("  โปรโมชั่น  "), baseCtx);
    expect(result).toEqual([{ type: "text", text: "รับส่วนลด 20% วันนี้เท่านั้น!" }]);
  });

  it("matchesIntent() returns false for non-matching text and handleEvent() returns no messages", async () => {
    expect(BroadcastModule.matchesIntent(makeTextEvent("สวัสดีครับ"), config)).toBe(false);

    mockMaybeSingle.mockResolvedValueOnce({ data: { settings: config }, error: null });
    const result = await BroadcastModule.handleEvent(makeTextEvent("สวัสดีครับ"), baseCtx);
    expect(result).toEqual([]);
  });

  it("matchesIntent() returns false when there is no configured trigger_keyword", () => {
    expect(BroadcastModule.matchesIntent(makeTextEvent("โปรโมชั่น"), {})).toBe(false);
  });

  it("matchesIntent() returns false for non-text events (e.g. sticker)", () => {
    const stickerEvent: LineEvent = {
      type: "message",
      message: { id: "msg-2", type: "sticker" },
      source: { type: "user", userId: "user-1" },
      timestamp: Date.now(),
    };
    expect(BroadcastModule.matchesIntent(stickerEvent, config)).toBe(false);
  });
});

describe("BroadcastModule — handleScheduledJob variable substitution", () => {
  const broadcastRow = {
    id: "broadcast-1",
    tenant_id: "tenant-1",
    message_type: "text" as const,
    payload: { text: "สวัสดีค่ะ วันนี้ {{date}} มีโปรโมชั่นพิเศษรอคุณอยู่!" },
  };

  const job: ScheduledJob = {
    id: "job-1",
    tenantId: "tenant-1",
    jobType: "broadcast",
    refId: "broadcast-1",
    targetId: "target-1",
    cronExpr: null,
    runAt: "2026-07-02T00:00:00.000Z",
    timezone: "Asia/Bangkok",
  };

  it("renders {{date}} substitution using the job timezone for a text broadcast", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: broadcastRow, error: null });

    const fixedNow = new Date("2026-07-02T10:00:00.000Z");
    const expectedDate = fixedNow.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok" });

    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const result = await BroadcastModule.handleScheduledJob!(job, baseCtx);

    vi.useRealTimers();

    expect(result).toEqual([
      { type: "text", text: `สวัสดีค่ะ วันนี้ ${expectedDate} มีโปรโมชั่นพิเศษรอคุณอยู่!` },
    ]);
  });

  it("substitutes {{date}} anywhere within a nested flex payload", async () => {
    const flexRow = {
      id: "broadcast-2",
      tenant_id: "tenant-1",
      message_type: "flex" as const,
      payload: {
        altText: "อัปเดตวันที่ {{date}}",
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [{ type: "text", text: "วันนี้คือ {{date}}" }],
          },
        },
      },
    };
    mockMaybeSingle.mockResolvedValueOnce({ data: flexRow, error: null });

    const fixedNow = new Date("2026-12-25T03:00:00.000Z");
    const expectedDate = fixedNow.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok" });

    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const result = await BroadcastModule.handleScheduledJob!(job, baseCtx);

    vi.useRealTimers();

    expect(result).toEqual([
      {
        type: "flex",
        altText: `อัปเดตวันที่ ${expectedDate}`,
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [{ type: "text", text: `วันนี้คือ ${expectedDate}` }],
          },
        },
      },
    ]);
  });

  it("returns no messages when job_type is not 'broadcast'", async () => {
    const nonBroadcastJob: ScheduledJob = { ...job, jobType: "morning_brief" };
    const result = await BroadcastModule.handleScheduledJob!(nonBroadcastJob, baseCtx);
    expect(result).toEqual([]);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns no messages when the referenced broadcast row does not exist", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await BroadcastModule.handleScheduledJob!(job, baseCtx);
    expect(result).toEqual([]);
  });
});
