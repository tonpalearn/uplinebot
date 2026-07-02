import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LineEvent, TenantContext, ModuleConfig, OutboundMessage } from "../lib/modules/types";

/**
 * Unit tests for the Assistant module's Todo Manager (lib/modules/assistant/handler.ts
 * + todo.ts + flex.ts + datetime.ts), driven through the public ModuleHandler contract
 * (matchesIntent / handleEvent) exactly as the Command Router would call it.
 *
 * The list surface is a numbered Flex card (buildTodoListFlex), so the assertions walk the
 * Flex bubble JSON rather than matching plain text. Confirmations that stay plain text
 * (empty list, unknown number, plan link) are matched as text.
 *
 * No live Postgres/Supabase instance is used. lib/db.ts's getServiceClient() is mocked with
 * an in-memory fake mimicking the PostgREST query-builder chains todo.ts / plan-token.ts use:
 *   .from("upl_todos").select(...).eq("target_id",..).order(...)          -> { data, error }
 *   .from("upl_todos").insert(rows)                                       -> { error }
 *   .from("upl_todos").update(patch).in("id", ids)                        -> { error }
 *   .from("upl_todos").update(patch).eq("id", id)                         -> { error }
 *   .from("upl_todos").delete().in("id", ids)                             -> { error }
 *   .from("upl_todos").delete({count}).eq("target_id",..)                 -> { error }
 *   .from("upl_todos").delete({count}).eq("target_id",..).eq("done",true) -> { error }
 *   .from("upl_targets").select("plan_token").eq("id",..).maybeSingle()   -> { data, error }
 *   .from("upl_targets").update({plan_token}).eq("id",..)                 -> { error }
 */

interface FakeTodoRow {
  id: string;
  target_id: string;
  content: string;
  done: boolean;
  due_at: string | null;
  reminded_at: string | null;
  sort_order: number | null;
  created_at: string;
}

interface FakeTargetRow {
  id: string;
  plan_token: string | null;
}

let store: FakeTodoRow[] = [];
let targets: FakeTargetRow[] = [];
let idCounter = 0;
let createdAtCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `todo-${idCounter}`;
}

function nextCreatedAt(): string {
  createdAtCounter += 1;
  return `2026-01-01T00:00:${String(createdAtCounter).padStart(2, "0")}.000Z`;
}

function makeFakeSupabase() {
  function fromTable(table: string) {
    if (table === "upl_todos") return todosBuilder();
    if (table === "upl_targets") return targetsBuilder();
    throw new Error(`Fake Supabase client does not support table "${table}"`);
  }

  function todosBuilder() {
    let mode: "select" | "insert" | "update" | "delete" | null = null;
    let insertRows: Partial<FakeTodoRow>[] = [];
    let updatePatch: Partial<FakeTodoRow> | null = null;
    let deleteCountRequested = false;
    let eqTargetId: string | null = null;
    let eqDone: boolean | null = null;
    let eqId: string | null = null;
    let inIds: string[] | null = null;

    function resolve(): { data: FakeTodoRow[] | null; error: null; count?: number } {
      if (mode === "select") {
        let rows = store.slice();
        if (eqTargetId !== null) rows = rows.filter((r) => r.target_id === eqTargetId);
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
        return { data: rows, error: null };
      }

      if (mode === "insert") {
        const inserted: FakeTodoRow[] = insertRows.map((r) => ({
          id: nextId(),
          target_id: String(r.target_id),
          content: String(r.content),
          done: false,
          due_at: (r.due_at as string | null) ?? null,
          reminded_at: null,
          sort_order: (r.sort_order as number | null) ?? null,
          created_at: nextCreatedAt(),
        }));
        store.push(...inserted);
        return { data: inserted, error: null };
      }

      if (mode === "update") {
        let count = 0;
        store = store.map((r) => {
          const matchById = eqId !== null && r.id === eqId;
          const matchByIn = inIds !== null && inIds.includes(r.id);
          if (matchById || matchByIn) {
            count += 1;
            return { ...r, ...updatePatch };
          }
          return r;
        });
        return { data: null, error: null, count };
      }

      if (mode === "delete") {
        let removed = 0;
        if (inIds) {
          const idsToRemove = new Set(inIds);
          const before = store.length;
          store = store.filter((r) => !idsToRemove.has(r.id));
          removed = before - store.length;
        } else if (deleteCountRequested && eqTargetId !== null) {
          const before = store.length;
          store = store.filter((r) => {
            const targetMatch = r.target_id === eqTargetId;
            const doneMatch = eqDone === null || r.done === eqDone;
            // keep rows that DON'T match the delete filter
            return !(targetMatch && doneMatch);
          });
          removed = before - store.length;
        }
        return { data: null, error: null, count: removed };
      }

      return { data: null, error: null };
    }

    const builder: any = {
      select() {
        mode = "select";
        return builder;
      },
      insert(rows: Partial<FakeTodoRow>[]) {
        mode = "insert";
        insertRows = rows;
        return builder;
      },
      update(patch: Partial<FakeTodoRow>) {
        mode = "update";
        updatePatch = patch;
        return builder;
      },
      delete(opts?: { count?: string }) {
        mode = "delete";
        deleteCountRequested = Boolean(opts?.count);
        return builder;
      },
      eq(column: string, value: unknown) {
        if (column === "target_id") eqTargetId = value as string;
        if (column === "done") eqDone = value as boolean;
        if (column === "id") eqId = value as string;
        return builder;
      },
      in(column: string, values: string[]) {
        if (column === "id") inIds = values;
        return builder;
      },
      order() {
        return builder;
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };

    return builder;
  }

  function targetsBuilder() {
    let mode: "select" | "update" | null = null;
    let updatePatch: Partial<FakeTargetRow> | null = null;
    let eqId: string | null = null;

    const builder: any = {
      select() {
        mode = "select";
        return builder;
      },
      update(patch: Partial<FakeTargetRow>) {
        mode = "update";
        updatePatch = patch;
        return builder;
      },
      eq(column: string, value: unknown) {
        if (column === "id") eqId = value as string;
        return builder;
      },
      async maybeSingle() {
        if (mode === "select") {
          const row = targets.find((t) => t.id === eqId) ?? null;
          return { data: row ? { plan_token: row.plan_token } : null, error: null };
        }
        return { data: null, error: null };
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        // Only the update path is awaited directly (select uses maybeSingle()).
        if (mode === "update" && eqId !== null) {
          let existing = targets.find((t) => t.id === eqId);
          if (!existing) {
            existing = { id: eqId, plan_token: null };
            targets.push(existing);
          }
          Object.assign(existing, updatePatch);
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      },
    };

    return builder;
  }

  return { from: fromTable };
}

vi.mock("../lib/db", () => ({
  getServiceClient: vi.fn(() => makeFakeSupabase()),
}));

// Imported AFTER vi.mock so the mocked module boundary is in place.
const { AssistantModule } = await import("../lib/modules/assistant/handler");

const TARGET_ID = "target-abc";
const OTHER_TARGET_ID = "target-xyz";

const baseConfig: ModuleConfig = {};

function makeTextEvent(text: string): LineEvent {
  return {
    type: "message",
    message: { id: "msg-1", type: "text", text },
    source: { type: "group", groupId: TARGET_ID },
    timestamp: Date.now(),
  };
}

function makeCtx(targetId: string = TARGET_ID): TenantContext {
  return { tenantId: "tenant-1", targetId, botId: "bot-1", sourceType: "group" };
}

function textOf(messages: OutboundMessage[]): string {
  return messages.map((m) => m.text ?? "").join("\n");
}

// ── Flex walkers ──────────────────────────────────────────────────────────────────────────

/** Recursively collect every `text` string from a Flex contents tree. */
function collectFlexText(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== "object") return acc;
  const obj = node as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") acc.push(obj.text);
  const contents = obj.contents;
  if (Array.isArray(contents)) {
    for (const child of contents) collectFlexText(child, acc);
  }
  // also walk header/body/footer boxes
  for (const key of ["header", "body", "footer"]) {
    if (obj[key]) collectFlexText(obj[key], acc);
  }
  return acc;
}

/** All text lines from the first flex message in the result, joined by newline. */
function flexText(messages: OutboundMessage[]): string {
  const flex = messages.find((m) => m.type === "flex");
  if (!flex || !flex.contents) return "";
  return collectFlexText(flex.contents).join("\n");
}

function firstMessage(messages: OutboundMessage[]): OutboundMessage {
  expect(messages.length).toBeGreaterThan(0);
  return messages[0];
}

beforeEach(() => {
  store = [];
  targets = [];
  idCounter = 0;
  createdAtCounter = 0;
  vi.clearAllMocks();
});

describe("AssistantModule — Todo Manager (mocked Supabase boundary)", () => {
  it("(1) adding with multiple lines creates multiple todos and replies with a Flex list", async () => {
    const event = makeTextEvent("เพิ่ม ซื้อของ\nโทรหาลูกค้า\nส่งเอกสาร");
    const ctx = makeCtx();

    expect(AssistantModule.matchesIntent(event, baseConfig)).toBe(true);

    const result = await AssistantModule.handleEvent(event, ctx);

    const rowsForTarget = store.filter((r) => r.target_id === TARGET_ID);
    expect(rowsForTarget).toHaveLength(3);
    expect(rowsForTarget.map((r) => r.content)).toEqual(["ซื้อของ", "โทรหาลูกค้า", "ส่งเอกสาร"]);
    expect(rowsForTarget.every((r) => r.done === false)).toBe(true);

    // Reply is a Flex card listing all three, numbered.
    const msg = firstMessage(result);
    expect(msg.type).toBe("flex");
    const text = flexText(result);
    expect(text).toContain("รายการงาน");
    expect(text).toContain("1");
    expect(text).toContain("ซื้อของ");
    expect(text).toContain("โทรหาลูกค้า");
    expect(text).toContain("ส่งเอกสาร");
    // Quick Reply attached with the three fixed buttons.
    expect(msg.quickReply?.items.map((i) => i.action.text)).toEqual([
      "งานวันนี้",
      "วางแผน",
      "ล้างที่เสร็จ",
    ]);
  });

  it("(2) listing shows open todos as a numbered Flex card, scoped per target", async () => {
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานหนึ่ง\nงานสอง"), makeCtx());
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานของคนอื่น"), makeCtx(OTHER_TARGET_ID));

    const listEvent = makeTextEvent("งานวันนี้");
    expect(AssistantModule.matchesIntent(listEvent, baseConfig)).toBe(true);

    const result = await AssistantModule.handleEvent(listEvent, makeCtx());
    const text = flexText(result);

    expect(text).toContain("ค้าง 2/ทั้งหมด 2");
    expect(text).toContain("งานหนึ่ง");
    expect(text).toContain("งานสอง");
    expect(text).not.toContain("งานของคนอื่น");
  });

  it("(3) marking one done by number works and re-renders the list", async () => {
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานหนึ่ง\nงานสอง\nงานสาม"), makeCtx());

    const doneEvent = makeTextEvent("เสร็จ 2");
    expect(AssistantModule.matchesIntent(doneEvent, baseConfig)).toBe(true);

    const doneResult = await AssistantModule.handleEvent(doneEvent, makeCtx());
    // Re-rendered Flex list; the done item is prefixed with the ✅ marker.
    expect(doneResult[0].type).toBe("flex");
    expect(flexText(doneResult)).toContain("✅ งานสอง");

    const rowsForTarget = store.filter((r) => r.target_id === TARGET_ID);
    expect(rowsForTarget.find((r) => r.content === "งานสอง")?.done).toBe(true);
    expect(rowsForTarget.find((r) => r.content === "งานหนึ่ง")?.done).toBe(false);
    expect(rowsForTarget.find((r) => r.content === "งานสาม")?.done).toBe(false);

    const listResult = await AssistantModule.handleEvent(makeTextEvent("งานวันนี้"), makeCtx());
    expect(flexText(listResult)).toContain("ค้าง 2/ทั้งหมด 3");
  });

  it("(4) removing one by number works and renumbers contiguously", async () => {
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานหนึ่ง\nงานสอง\nงานสาม"), makeCtx());

    const deleteEvent = makeTextEvent("ลบ 1");
    expect(AssistantModule.matchesIntent(deleteEvent, baseConfig)).toBe(true);

    const deleteResult = await AssistantModule.handleEvent(deleteEvent, makeCtx());
    expect(deleteResult[0].type).toBe("flex");

    const rowsForTarget = store.filter((r) => r.target_id === TARGET_ID);
    expect(rowsForTarget).toHaveLength(2);
    expect(rowsForTarget.map((r) => r.content)).toEqual(["งานสอง", "งานสาม"]);

    const text = flexText(deleteResult);
    expect(text).toContain("ค้าง 2/ทั้งหมด 2");
    expect(text).toContain("งานสอง");
    expect(text).toContain("งานสาม");
    expect(text).not.toContain("งานหนึ่ง");
  });

  it("(5) unrelated text does not match", async () => {
    const event = makeTextEvent("สวัสดีครับวันนี้อากาศดีมาก");
    expect(AssistantModule.matchesIntent(event, baseConfig)).toBe(false);

    const result = await AssistantModule.handleEvent(event, makeCtx());
    expect(result).toEqual([]);
    expect(store).toHaveLength(0);
  });

  it("(6) adding with a Thai date/time stores due_at and strips it from the content", async () => {
    // Use a fixed 'now' indirectly: parseThaiDateTime uses new Date() here, so assert on
    // the row shape rather than an exact instant.
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม ประชุมทีม พรุ่งนี้ 14:00"), makeCtx());

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("ประชุมทีม");
    expect(rows[0].due_at).not.toBeNull();
    // 14:00 Bangkok => 07:00 UTC
    expect(new Date(rows[0].due_at as string).getUTCHours()).toBe(7);
  });

  it("(7) 'เลื่อน N <เวลา>' reschedules the task's due_at", async () => {
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานเอ\nงานบี"), makeCtx());

    const ev = makeTextEvent("เลื่อน 2 พรุ่งนี้ 9 โมง");
    expect(AssistantModule.matchesIntent(ev, baseConfig)).toBe(true);

    const result = await AssistantModule.handleEvent(ev, makeCtx());
    expect(result[0].type).toBe("flex");

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    const bee = rows.find((r) => r.content === "งานบี");
    expect(bee?.due_at).not.toBeNull();
    expect(new Date(bee!.due_at as string).getUTCHours()).toBe(2); // 09:00 BKK => 02:00 UTC
  });

  it("(8) 'ล้างที่เสร็จ' deletes only done todos", async () => {
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานหนึ่ง\nงานสอง\nงานสาม"), makeCtx());
    await AssistantModule.handleEvent(makeTextEvent("เสร็จ 1 3"), makeCtx());

    const ev = makeTextEvent("ล้างที่เสร็จ");
    expect(AssistantModule.matchesIntent(ev, baseConfig)).toBe(true);

    const result = await AssistantModule.handleEvent(ev, makeCtx());
    expect(result[0].type).toBe("flex");

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    expect(rows.map((r) => r.content)).toEqual(["งานสอง"]);
  });

  it("(9) 'วางแผน' returns the calendar link with a per-target plan token", async () => {
    const ev = makeTextEvent("วางแผน");
    expect(AssistantModule.matchesIntent(ev, baseConfig)).toBe(true);

    const result = await AssistantModule.handleEvent(ev, makeCtx());
    const msg = firstMessage(result);
    expect(msg.type).toBe("text");
    expect(msg.text).toContain("/plan/");
    // Token was persisted on the target row.
    const t = targets.find((x) => x.id === TARGET_ID);
    expect(t?.plan_token).toBeTruthy();
    expect(msg.text).toContain(t!.plan_token as string);

    // Second call is idempotent — same token, no new token minted.
    const result2 = await AssistantModule.handleEvent(makeTextEvent("ปฏิทิน"), makeCtx());
    expect(result2[0].text).toContain(t!.plan_token as string);
  });

  it("(10) empty list replies with a plain-text prompt (with Quick Reply), not a Flex card", async () => {
    const result = await AssistantModule.handleEvent(makeTextEvent("งานวันนี้"), makeCtx());
    const msg = firstMessage(result);
    expect(msg.type).toBe("text");
    expect(msg.text).toContain("ยังไม่มีงานในรายการ");
    expect(msg.quickReply?.items.length).toBe(3);
  });
});
