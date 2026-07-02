import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LineEvent, TenantContext, ModuleConfig } from "../lib/modules/types";

/**
 * Unit tests for the Assistant module's Todo Manager (lib/modules/assistant/handler.ts
 * + todo.ts), driven through the public ModuleHandler contract (matchesIntent /
 * handleEvent) exactly as the Command Router would call it.
 *
 * No live Postgres/Supabase instance is used or required. lib/db.ts's
 * getServiceClient() is mocked out with an in-memory fake that mimics the exact
 * PostgREST query-builder chains used by todo.ts:
 *   .from("upl_todos").select(...).eq(...).order(...)         -> { data, error }
 *   .from("upl_todos").insert(rows)                           -> { error }
 *   .from("upl_todos").update({done:true}).in("id", ids)      -> { error }
 *   .from("upl_todos").delete().in("id", ids)                 -> { error }
 *   .from("upl_todos").delete({count:"exact"}).eq(...)        -> { error, count }
 *
 * This verifies AssistantModule's intent-matching + CRUD branching logic in
 * isolation from any real database.
 */

interface FakeRow {
  id: string;
  target_id: string;
  content: string;
  done: boolean;
  due_date: string | null;
  created_at: string;
}

let store: FakeRow[] = [];
let idCounter = 0;
let createdAtCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `todo-${idCounter}`;
}

function nextCreatedAt(): string {
  createdAtCounter += 1;
  // Monotonically increasing ISO-ish timestamp so "oldest first" ordering is stable.
  return `2026-01-01T00:00:${String(createdAtCounter).padStart(2, "0")}.000Z`;
}

/**
 * Minimal fake query builder. Each method returns `this` so calls can be chained
 * the same way the real supabase-js builder allows, and the object is awaitable
 * (via `.then`) so `await supabase.from(...).select(...).eq(...).order(...)` resolves
 * to `{ data, error }` the way todo.ts expects.
 */
function makeFakeSupabase() {
  function fromTable(table: string) {
    if (table !== "upl_todos") {
      throw new Error(`Fake Supabase client does not support table "${table}"`);
    }

    let mode: "select" | "insert" | "update" | "delete" | null = null;
    let insertRows: Partial<FakeRow>[] = [];
    let updatePatch: Partial<FakeRow> | null = null;
    let deleteCountRequested = false;
    let eqTargetId: string | null = null;
    let inIds: string[] | null = null;

    function resolve(): { data: FakeRow[] | null; error: null; count?: number } {
      if (mode === "select") {
        let rows = store.slice();
        if (eqTargetId !== null) {
          rows = rows.filter((r) => r.target_id === eqTargetId);
        }
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
        return { data: rows, error: null };
      }

      if (mode === "insert") {
        const inserted: FakeRow[] = insertRows.map((r) => ({
          id: nextId(),
          target_id: String(r.target_id),
          content: String(r.content),
          done: false,
          due_date: null,
          created_at: nextCreatedAt(),
        }));
        store.push(...inserted);
        return { data: inserted, error: null };
      }

      if (mode === "update") {
        let count = 0;
        if (inIds) {
          store = store.map((r) => {
            if (inIds!.includes(r.id)) {
              count += 1;
              return { ...r, ...updatePatch };
            }
            return r;
          });
        }
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
          store = store.filter((r) => r.target_id !== eqTargetId);
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
      insert(rows: Partial<FakeRow>[]) {
        mode = "insert";
        insertRows = rows;
        return builder;
      },
      update(patch: Partial<FakeRow>) {
        mode = "update";
        updatePatch = patch;
        return builder;
      },
      delete(opts?: { count?: string }) {
        mode = "delete";
        deleteCountRequested = Boolean(opts?.count);
        return builder;
      },
      eq(column: string, value: string) {
        if (column === "target_id") eqTargetId = value;
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
  return {
    tenantId: "tenant-1",
    targetId,
    botId: "bot-1",
    sourceType: "group",
  };
}

function textOf(messages: { type: string; text?: string }[]): string {
  return messages.map((m) => m.text ?? "").join("\n");
}

beforeEach(() => {
  store = [];
  idCounter = 0;
  createdAtCounter = 0;
  vi.clearAllMocks();
});

describe("AssistantModule — Todo Manager (mocked Supabase boundary)", () => {
  it("(1) adding with multiple lines creates multiple todos", async () => {
    const event = makeTextEvent("เพิ่ม ซื้อของ\nโทรหาลูกค้า\nส่งเอกสาร");
    const ctx = makeCtx();

    expect(AssistantModule.matchesIntent(event, baseConfig)).toBe(true);

    const result = await AssistantModule.handleEvent(event, ctx);

    const rowsForTarget = store.filter((r) => r.target_id === TARGET_ID);
    expect(rowsForTarget).toHaveLength(3);
    expect(rowsForTarget.map((r) => r.content)).toEqual(["ซื้อของ", "โทรหาลูกค้า", "ส่งเอกสาร"]);
    expect(rowsForTarget.every((r) => r.done === false)).toBe(true);

    const text = textOf(result);
    expect(text).toContain("เพิ่ม 3 งานแล้ว");
    expect(text).toContain("ซื้อของ");
    expect(text).toContain("โทรหาลูกค้า");
    expect(text).toContain("ส่งเอกสาร");
  });

  it("(2) listing shows open todos", async () => {
    // Seed via the add path so IDs/ordering come from the module itself.
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานหนึ่ง\nงานสอง"), makeCtx());
    // Seed a todo under a different target to confirm scoping doesn't leak.
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานของคนอื่น"), makeCtx(OTHER_TARGET_ID));

    const listEvent = makeTextEvent("งานวันนี้");
    expect(AssistantModule.matchesIntent(listEvent, baseConfig)).toBe(true);

    const result = await AssistantModule.handleEvent(listEvent, makeCtx());
    const text = textOf(result);

    expect(text).toContain("ค้าง 2/2");
    expect(text).toContain("1. [ ] งานหนึ่ง");
    expect(text).toContain("2. [ ] งานสอง");
    expect(text).not.toContain("งานของคนอื่น");
  });

  it("(3) marking one done by number works", async () => {
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานหนึ่ง\nงานสอง\nงานสาม"), makeCtx());

    const doneEvent = makeTextEvent("เสร็จ 2");
    expect(AssistantModule.matchesIntent(doneEvent, baseConfig)).toBe(true);

    const doneResult = await AssistantModule.handleEvent(doneEvent, makeCtx());
    expect(textOf(doneResult)).toContain("ทำเสร็จแล้ว");
    expect(textOf(doneResult)).toContain("งานสอง");

    const rowsForTarget = store.filter((r) => r.target_id === TARGET_ID);
    const second = rowsForTarget.find((r) => r.content === "งานสอง");
    expect(second?.done).toBe(true);
    expect(rowsForTarget.find((r) => r.content === "งานหนึ่ง")?.done).toBe(false);
    expect(rowsForTarget.find((r) => r.content === "งานสาม")?.done).toBe(false);

    const listResult = await AssistantModule.handleEvent(makeTextEvent("งานวันนี้"), makeCtx());
    expect(textOf(listResult)).toContain("ค้าง 2/3");
    expect(textOf(listResult)).toContain("2. [x] งานสอง");
  });

  it("(4) removing one by number works", async () => {
    await AssistantModule.handleEvent(makeTextEvent("เพิ่ม งานหนึ่ง\nงานสอง\nงานสาม"), makeCtx());

    const deleteEvent = makeTextEvent("ลบ 1");
    expect(AssistantModule.matchesIntent(deleteEvent, baseConfig)).toBe(true);

    const deleteResult = await AssistantModule.handleEvent(deleteEvent, makeCtx());
    expect(textOf(deleteResult)).toContain("ลบแล้ว");
    expect(textOf(deleteResult)).toContain("งานหนึ่ง");

    const rowsForTarget = store.filter((r) => r.target_id === TARGET_ID);
    expect(rowsForTarget).toHaveLength(2);
    expect(rowsForTarget.map((r) => r.content)).toEqual(["งานสอง", "งานสาม"]);

    const listResult = await AssistantModule.handleEvent(makeTextEvent("งานวันนี้"), makeCtx());
    const text = textOf(listResult);
    expect(text).toContain("ค้าง 2/2");
    expect(text).toContain("1. [ ] งานสอง");
    expect(text).toContain("2. [ ] งานสาม");
    expect(text).not.toContain("งานหนึ่ง");
  });

  it("(5) unrelated text does not match", async () => {
    const event = makeTextEvent("สวัสดีครับวันนี้อากาศดีมาก");
    expect(AssistantModule.matchesIntent(event, baseConfig)).toBe(false);

    const result = await AssistantModule.handleEvent(event, makeCtx());
    expect(result).toEqual([]);
    expect(store).toHaveLength(0);
  });
});
