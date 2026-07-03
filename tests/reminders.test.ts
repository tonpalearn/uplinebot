import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * scanTodoReminders() — time-based todo reminder fan-out (lib/reminders.ts).
 *
 * Contract under test (SPEC §6.3 + migration 0003):
 *   1. Query upl_todos for rows that are DUE (due_at <= now), NOT done, and NOT yet reminded.
 *   2. For each such row, resolve its target (upl_targets.line_source_id + bot_id), decrypt the
 *      bot's access token (upl_bots.access_token_enc), and pushMessage() a LINE reminder to that
 *      target's line_source_id using that bot's token.
 *   3. Stamp reminded_at = now on exactly the rows that fired (so they never fire twice).
 *
 * We stand up a fake Supabase (`upl_todos` / `upl_targets` / `upl_bots`) as an in-memory query
 * builder, seed FOUR todos — 2 due+pending, 1 not-yet-due, 1 already-reminded — and assert:
 *   - pushMessage is called exactly twice (only the 2 due+pending+un-reminded rows),
 *   - each push targets the correct line_source_id with that bot's DECRYPTED token,
 *   - reminded_at is stamped on exactly those 2 rows (we capture every update payload+id).
 *
 * The DB filtering is emulated honestly: the fake applies .lte("due_at") / .eq("done") /
 * .is("reminded_at", null) to the seeded rows, so "not-yet-due" and "already-reminded" are
 * excluded by the same predicate contract the real query relies on — the test is not hand-fed
 * a pre-filtered list.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = new Date("2026-07-02T05:00:00.000Z"); // fixed "now" for deterministic due comparisons

// Two bots, two targets (chats). Each due todo routes to a different bot+chat so we can prove
// the push uses the RIGHT line_source_id with the RIGHT token, not a single shared credential.
const BOT_1 = { id: "bot-1", access_token: "token-bot-1-plain" };
const BOT_2 = { id: "bot-2", access_token: "token-bot-2-plain" };

const TARGET_1 = { id: "target-1", line_source_id: "Uchat0000000001", bot_id: BOT_1.id };
const TARGET_2 = { id: "target-2", line_source_id: "Cgroup000000002", bot_id: BOT_2.id };

// Encrypted-at-rest form the fake DB hands back for *_enc columns; the mocked decrypt() below
// reverses the `enc:` prefix (mirrors how the real code round-trips access_token_enc).
const encOf = (plain: string) => `enc:${plain}`;

// Four seeded todos. Only DUE_A and DUE_B satisfy (due & !done & reminded_at IS NULL).
const DUE_A = {
  id: "todo-due-A",
  target_id: TARGET_1.id,
  content: "ส่งรายงานลูกค้า",
  due_at: "2026-07-02T04:30:00.000Z", // 30 min BEFORE now -> due
  done: false,
  reminded_at: null as string | null,
};
const DUE_B = {
  id: "todo-due-B",
  target_id: TARGET_2.id,
  content: "โทรหาพี่แจ๊ค",
  due_at: "2026-07-02T05:00:00.000Z", // exactly now -> due (lte is inclusive)
  done: false,
  reminded_at: null as string | null,
};
const NOT_YET_DUE = {
  id: "todo-future",
  target_id: TARGET_1.id,
  content: "งานพรุ่งนี้",
  due_at: "2026-07-03T05:00:00.000Z", // 24h AFTER now -> NOT due
  done: false,
  reminded_at: null as string | null,
};
const ALREADY_REMINDED = {
  id: "todo-reminded",
  target_id: TARGET_2.id,
  content: "งานที่เตือนไปแล้ว",
  due_at: "2026-07-02T03:00:00.000Z", // due, but...
  done: false,
  reminded_at: "2026-07-02T03:00:05.000Z", // ...already reminded -> excluded
};

const SEED_TODOS = [DUE_A, DUE_B, NOT_YET_DUE, ALREADY_REMINDED];

// Capture of every upl_todos UPDATE the code issues: { id, payload }.
interface CapturedUpdate {
  id: string;
  payload: Record<string, unknown>;
}
const capturedUpdates: CapturedUpdate[] = [];

// ---------------------------------------------------------------------------
// Mock lib/db — minimal in-memory Supabase query builder.
//
//   upl_todos  (SELECT):  .select().lte().eq().is().order().limit()  -> awaitable {data,error}
//                          (applies the due/done/reminded predicates to SEED_TODOS)
//   upl_todos  (UPDATE):  .update(payload).eq("id", id)              -> awaitable {error}
//                          (records the payload+id into capturedUpdates)
//   upl_targets(SELECT):  .select().eq("id").maybeSingle()           -> {data,error}
//   upl_bots   (SELECT):  .select().eq("id").maybeSingle()           -> {data,error}
// ---------------------------------------------------------------------------
vi.mock("../lib/db", () => {
  function makeQuery(table: string) {
    const filters: Record<string, unknown> = {};
    let updatePayload: Record<string, unknown> | null = null;

    // Resolve a terminal SELECT that returns a LIST (upl_todos scan).
    const resolveTodoList = () => {
      let rows = SEED_TODOS.slice();
      if ("due_at_lte" in filters) {
        const bound = filters.due_at_lte as string;
        rows = rows.filter((r) => r.due_at <= bound);
      }
      if ("done" in filters) {
        rows = rows.filter((r) => r.done === filters.done);
      }
      if (filters.reminded_at_is_null === true) {
        rows = rows.filter((r) => r.reminded_at === null);
      }
      // Return only the selected shape the caller reads (id, target_id, content, due_at).
      const data = rows.map((r) => ({
        id: r.id,
        target_id: r.target_id,
        content: r.content,
        due_at: r.due_at,
      }));
      return { data, error: null };
    };

    // Resolve a terminal SELECT that returns a SINGLE row (targets / bots).
    const resolveSingle = () => {
      if (table === "upl_targets") {
        const row = [TARGET_1, TARGET_2].find((t) => t.id === filters.id);
        if (!row) return { data: null, error: null };
        return {
          data: { line_source_id: row.line_source_id, bot_id: row.bot_id },
          error: null,
        };
      }
      if (table === "upl_bots") {
        const row = [BOT_1, BOT_2].find((b) => b.id === filters.id);
        if (!row) return { data: null, error: null };
        return { data: { access_token_enc: encOf(row.access_token) }, error: null };
      }
      return { data: null, error: null };
    };

    const builder: Record<string, unknown> = {
      select: (_cols?: string) => builder,
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload;
        return builder;
      },
      lte: (col: string, val: unknown) => {
        if (col === "due_at") filters.due_at_lte = val;
        return builder;
      },
      is: (col: string, val: unknown) => {
        if (col === "reminded_at" && val === null) filters.reminded_at_is_null = true;
        return builder;
      },
      order: (_col: string, _opts?: unknown) => builder,
      // limit() is the terminal awaited op on the upl_todos SELECT chain.
      limit: (_n: number) => Promise.resolve(resolveTodoList()),
      // eq() may be terminal: on upl_todos after update() it resolves the UPDATE;
      // on targets/bots it's followed by maybeSingle(). We make it a thenable so both work.
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        if (table === "upl_todos" && updatePayload !== null) {
          // Terminal UPDATE: .update({...}).eq("id", <id>)
          const id = String(val);
          capturedUpdates.push({ id, payload: updatePayload });
          const settled = { error: null };
          // Return a thenable so `await ...update().eq(...)` resolves to {error}.
          return {
            then: (resolve: (v: unknown) => unknown) => resolve(settled),
          };
        }
        return builder;
      },
      maybeSingle: async () => resolveSingle(),
    };
    return builder;
  }

  return {
    getServiceClient: () => ({
      from: (table: string) => makeQuery(table),
    }),
  };
});

// Mock lib/crypto decrypt — reverse the `enc:` prefix to recover the plaintext token.
vi.mock("../lib/crypto", () => ({
  decrypt: (value: string) => (value.startsWith("enc:") ? value.slice("enc:".length) : value),
}));

// Spy on the LINE sender so nothing hits the network and we can assert (token, to, messages).
const pushMessageMock = vi.fn(async (..._args: any[]) => ({ ok: true, status: 200 }));
vi.mock("../lib/line/client", () => ({
  pushMessage: (...args: unknown[]) => pushMessageMock(...args),
}));

// Import AFTER mocks so lib/reminders binds to the mocked db / crypto / line client.
import { scanTodoReminders, reminderLead, isReminderDue, MAX_LEAD_MINUTES } from "../lib/reminders";
import { formatThaiDueAt } from "../lib/modules/assistant/datetime";

beforeEach(() => {
  pushMessageMock.mockClear();
  capturedUpdates.length = 0;
  // Reset any reminded_at mutations between tests (none mutate the seed here, but be safe).
  DUE_A.reminded_at = null;
  DUE_B.reminded_at = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("scanTodoReminders — only due + not-done + not-yet-reminded todos fire", () => {
  it("pushes exactly the 2 due/pending rows (skips not-yet-due and already-reminded)", async () => {
    const result = await scanTodoReminders(NOW);

    // Two reminders sent — NOT_YET_DUE and ALREADY_REMINDED were excluded by the query predicate.
    expect(result.sent).toBe(2);
    expect(pushMessageMock).toHaveBeenCalledTimes(2);

    // The two pushes correspond to DUE_A and DUE_B (by content in the text), not the excluded rows.
    const sentTexts = pushMessageMock.mock.calls.map(
      (c) => (c[2] as { text: string }[])[0].text
    );
    expect(sentTexts.some((t) => t.includes(DUE_A.content))).toBe(true);
    expect(sentTexts.some((t) => t.includes(DUE_B.content))).toBe(true);
    // Excluded rows never appear in any push.
    expect(sentTexts.some((t) => t.includes(NOT_YET_DUE.content))).toBe(false);
    expect(sentTexts.some((t) => t.includes(ALREADY_REMINDED.content))).toBe(false);
  });

  it("each push goes to the correct line_source_id with that bot's DECRYPTED access token", async () => {
    await scanTodoReminders(NOW);

    // Build a map: line_source_id -> access token used for the push to that chat.
    const byTarget = new Map<string, string>();
    for (const call of pushMessageMock.mock.calls) {
      const token = call[0] as string;
      const to = call[1] as string;
      byTarget.set(to, token);
    }

    // DUE_A -> TARGET_1 (bot-1); DUE_B -> TARGET_2 (bot-2). Tokens are the DECRYPTED plaintext.
    expect(byTarget.get(TARGET_1.line_source_id)).toBe(BOT_1.access_token);
    expect(byTarget.get(TARGET_2.line_source_id)).toBe(BOT_2.access_token);

    // Cross-check: bot-2's token was NOT used to push into bot-1's chat and vice versa.
    expect(byTarget.get(TARGET_1.line_source_id)).not.toBe(BOT_2.access_token);
    expect(byTarget.get(TARGET_2.line_source_id)).not.toBe(BOT_1.access_token);
  });

  it("sends a text message whose body matches the real Thai due-time formatting", async () => {
    await scanTodoReminders(NOW);

    const messagesByTarget = new Map<string, { type: string; text: string }[]>();
    for (const call of pushMessageMock.mock.calls) {
      messagesByTarget.set(call[1] as string, call[2] as { type: string; text: string }[]);
    }

    const msgsA = messagesByTarget.get(TARGET_1.line_source_id)!;
    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].type).toBe("text");
    // Exact text the production code composes for DUE_A.
    const expectedA = `⏰ ถึงเวลางาน: ${DUE_A.content} (กำหนด ${formatThaiDueAt(
      new Date(DUE_A.due_at),
      NOW
    )})`;
    expect(msgsA[0].text).toBe(expectedA);
  });

  it("stamps reminded_at=now on EXACTLY the 2 rows that fired (captured update payloads)", async () => {
    await scanTodoReminders(NOW);

    // Exactly two UPDATEs, one per fired row.
    expect(capturedUpdates).toHaveLength(2);

    // Each update sets reminded_at to the scan's `now` (ISO), and nothing else.
    for (const upd of capturedUpdates) {
      expect(upd.payload).toEqual({ reminded_at: NOW.toISOString() });
    }

    // The updated ids are precisely DUE_A and DUE_B — not the excluded rows.
    const updatedIds = capturedUpdates.map((u) => u.id).sort();
    expect(updatedIds).toEqual([DUE_A.id, DUE_B.id].sort());
    expect(updatedIds).not.toContain(NOT_YET_DUE.id);
    expect(updatedIds).not.toContain(ALREADY_REMINDED.id);
  });
});

// ── configurable lead-time helpers (pure) ──────────────────────────────────────────────────
describe("reminderLead — task override ?? target default ?? 0, clamped", () => {
  it("task override wins over the target default", () => {
    expect(reminderLead(5, 30)).toBe(5);
    expect(reminderLead(0, 30)).toBe(0); // explicit 0 override (ตรงเวลา) beats the default
  });

  it("falls back to the target default when there is no override", () => {
    expect(reminderLead(null, 30)).toBe(30);
    expect(reminderLead(undefined, 15)).toBe(15);
  });

  it("falls back to 0 when neither is set", () => {
    expect(reminderLead(null, null)).toBe(0);
    expect(reminderLead(undefined, undefined)).toBe(0);
  });

  it("clamps negatives to 0 and caps at MAX_LEAD_MINUTES", () => {
    expect(reminderLead(-10, 0)).toBe(0);
    expect(reminderLead(99999, 0)).toBe(MAX_LEAD_MINUTES);
    expect(reminderLead(null, 99999)).toBe(MAX_LEAD_MINUTES);
  });

  it("truncates fractional minutes", () => {
    expect(reminderLead(15.9, 0)).toBe(15);
  });
});

describe("isReminderDue — fire when now >= due_at - lead", () => {
  const due = Date.UTC(2026, 6, 3, 7, 0, 0); // 14:00 Bangkok

  it("lead 0: not due 1 min before, due exactly at due time", () => {
    expect(isReminderDue(due, due - 60_000, 0)).toBe(false);
    expect(isReminderDue(due, due, 0)).toBe(true);
  });

  it("lead 15: becomes due 15 minutes before due_at", () => {
    expect(isReminderDue(due, due - 16 * 60_000, 15)).toBe(false); // 16 min before → not yet
    expect(isReminderDue(due, due - 15 * 60_000, 15)).toBe(true); // exactly 15 min before → fire
    expect(isReminderDue(due, due - 5 * 60_000, 15)).toBe(true); // 5 min before → still due
  });

  it("stays due after the due time has passed", () => {
    expect(isReminderDue(due, due + 60_000, 10)).toBe(true);
  });
});
