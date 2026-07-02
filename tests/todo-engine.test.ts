import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutboundMessage } from "../lib/modules/types";

/**
 * QA suite for the UPGRADED Todo engine (lib/modules/assistant/todo.ts + datetime.ts + flex.ts),
 * exercising the engine functions DIRECTLY (parseTodoIntent + addTodos/listTodos/completeTodos/
 * deleteTodos/rescheduleTodo/clearDone) rather than through the ModuleHandler contract.
 *
 * Every `now` is passed explicitly so date math is deterministic (Asia/Bangkok = fixed UTC+7).
 *
 * No live Supabase. lib/db.ts's getServiceClient() is mocked with an in-memory fake `upl_todos`
 * store that mimics the PostgREST query-builder chains todo.ts uses:
 *   select + eq("target_id",..) + order(...)        -> { data, error }   (awaited via .then)
 *   insert(rows)                                     -> { data, error }
 *   update(patch) + in("id", ids)                    -> { error }
 *   update(patch) + eq("id", id)                     -> { error }
 *   delete() + in("id", ids)                         -> { error }
 *   delete({count}) + eq("target_id",..)             -> { error }   (delete_all)
 *   delete({count}) + eq("target_id",..).eq("done",true) -> { error }   (clear_done)
 */

// ── In-memory fake upl_todos store ──────────────────────────────────────────────────────────

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

let store: FakeTodoRow[] = [];
let idCounter = 0;
let createdAtCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `todo-${idCounter}`;
}

// Monotonically increasing created_at so insertion order == oldest-first order.
function nextCreatedAt(): string {
  createdAtCounter += 1;
  return `2026-01-01T00:00:${String(createdAtCounter).padStart(2, "0")}.000Z`;
}

function makeFakeSupabase() {
  function fromTable(table: string) {
    if (table === "upl_todos") return todosBuilder();
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
        // Fake .order("created_at", asc); todo.ts re-sorts in JS anyway.
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
          // delete().in("id", ids) — remove by id set
          const idsToRemove = new Set(inIds);
          const before = store.length;
          store = store.filter((r) => !idsToRemove.has(r.id));
          removed = before - store.length;
        } else if (eqTargetId !== null) {
          // delete({count}).eq("target_id",..) [.eq("done",true)] — delete_all / clear_done
          const before = store.length;
          store = store.filter((r) => {
            const targetMatch = r.target_id === eqTargetId;
            const doneMatch = eqDone === null || r.done === eqDone;
            return !(targetMatch && doneMatch); // keep rows that DON'T match the filter
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

  return { from: fromTable };
}

vi.mock("../lib/db", () => ({
  getServiceClient: vi.fn(() => makeFakeSupabase()),
}));

// Imported AFTER vi.mock so the mocked module boundary is in place.
const {
  parseTodoIntent,
  addTodos,
  listTodos,
  completeTodos,
  deleteTodos,
  rescheduleTodo,
  clearDone,
} = await import("../lib/modules/assistant/todo");
const { parseThaiDateTime } = await import("../lib/modules/assistant/datetime");

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

// NOW = 2026-07-02T03:00:00Z == 2026-07-02 10:00 Bangkok (a Thursday). Passed to every parser.
const NOW = new Date("2026-07-02T03:00:00Z");
const TARGET_ID = "target-abc";
const OTHER_TARGET_ID = "target-xyz";

beforeEach(() => {
  store = [];
  idCounter = 0;
  createdAtCounter = 0;
  vi.clearAllMocks();
});

// ── Flex walkers (mirror the real handler tests) ────────────────────────────────────────────

/** Recursively collect every `text` string from a Flex contents tree (incl. header/body/footer). */
function collectFlexText(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== "object") return acc;
  const obj = node as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") acc.push(obj.text);
  const contents = obj.contents;
  if (Array.isArray(contents)) {
    for (const child of contents) collectFlexText(child, acc);
  }
  for (const key of ["header", "body", "footer"]) {
    if (obj[key]) collectFlexText(obj[key], acc);
  }
  return acc;
}

function flexText(messages: OutboundMessage[]): string {
  const flex = messages.find((m) => m.type === "flex");
  if (!flex || !flex.contents) return "";
  return collectFlexText(flex.contents).join("\n");
}

/** Collect all number-chip strings (the `n` rendered in each row's chip box) in visible order. */
function flexNumbers(messages: OutboundMessage[]): number[] {
  const flex = messages.find((m) => m.type === "flex");
  if (!flex || !flex.contents) return [];
  const all = collectFlexText(flex.contents);
  // Row number chips are the pure-integer text entries; the header/footer text is prose.
  return all.filter((t) => /^\d+$/.test(t)).map((t) => parseInt(t, 10));
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// (1) parseTodoIntent — Thai keyword intent surface
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("(1) parseTodoIntent", () => {
  it("เพิ่ม single-line → add with one item", () => {
    expect(parseTodoIntent("เพิ่ม ซื้อของ")).toEqual({ action: "add", items: ["ซื้อของ"] });
  });

  it("เพิ่ม multi-line → add with first-line remainder + each following line", () => {
    const intent = parseTodoIntent("เพิ่ม ซื้อของ\nโทรหาลูกค้า\nส่งเอกสาร");
    expect(intent).toEqual({
      action: "add",
      items: ["ซื้อของ", "โทรหาลูกค้า", "ส่งเอกสาร"],
    });
  });

  it("ค้าง (primary) + งานวันนี้ / รายการ / list / todo → list", () => {
    for (const kw of ["ค้าง", "งานค้าง", "ดูงาน", "งานวันนี้", "รายการ", "list", "todo"]) {
      expect(parseTodoIntent(kw)).toEqual({ action: "list" });
    }
  });

  it("ปิดงาน: ลบ N / เสร็จ N (single and multiple) → done with indexes", () => {
    expect(parseTodoIntent("ลบ 1")).toEqual({ action: "done", indexes: [1] });
    expect(parseTodoIntent("ลบ 2 4")).toEqual({ action: "done", indexes: [2, 4] });
    expect(parseTodoIntent("เสร็จ 2")).toEqual({ action: "done", indexes: [2] });
    expect(parseTodoIntent("เสร็จ 1 3 5")).toEqual({ action: "done", indexes: [1, 3, 5] });
  });

  it("ลบทั้งหมด → delete_all", () => {
    expect(parseTodoIntent("ลบทั้งหมด")).toEqual({ action: "delete_all" });
  });

  it("เลื่อน N <when> → reschedule carrying index + whenText", () => {
    expect(parseTodoIntent("เลื่อน 2 พรุ่งนี้ 14:00")).toEqual({
      action: "reschedule",
      index: 2,
      whenText: "พรุ่งนี้ 14:00",
    });
  });

  it("ล้างที่เสร็จ → clear_done", () => {
    expect(parseTodoIntent("ล้างที่เสร็จ")).toEqual({ action: "clear_done" });
  });

  it("วางแผน / ปฏิทิน / calendar → plan", () => {
    for (const kw of ["วางแผน", "ปฏิทิน", "calendar"]) {
      expect(parseTodoIntent(kw)).toEqual({ action: "plan" });
    }
  });

  it("plain text WITHOUT เพิ่ม → null (not a todo); เพิ่ม multi-line = 1 line/task", () => {
    expect(parseTodoIntent("ซื้อของที่ตลาด")).toBeNull();
    expect(parseTodoIntent("สวัสดีครับวันนี้อากาศดีมาก")).toBeNull();
    expect(parseTodoIntent("")).toBeNull();
    expect(parseTodoIntent("   ")).toBeNull();
    expect(parseTodoIntent("เพิ่ม ซื้อของ\nโทรหาลูกค้า\nส่งเอกสาร")).toEqual({
      action: "add",
      items: ["ซื้อของ", "โทรหาลูกค้า", "ส่งเอกสาร"],
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// (2) parseThaiDateTime — deterministic with explicit `now`
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("(2) parseThaiDateTime", () => {
  it("'พรุ่งนี้ 14:00' → dueAt ~24h ahead at 14:00 Bangkok, tokens stripped", () => {
    const { dueAt, cleanedText } = parseThaiDateTime("ประชุม พรุ่งนี้ 14:00", NOW);
    expect(dueAt).not.toBeNull();

    // 14:00 Bangkok on 2026-07-03 == 07:00 UTC.
    expect(dueAt!.toISOString()).toBe("2026-07-03T07:00:00.000Z");

    // Reconstruct Bangkok wall clock (UTC + 7h) and assert 14:00.
    const bkk = new Date(dueAt!.getTime() + 7 * 60 * 60 * 1000);
    expect(bkk.getUTCFullYear()).toBe(2026);
    expect(bkk.getUTCMonth() + 1).toBe(7);
    expect(bkk.getUTCDate()).toBe(3);
    expect(bkk.getUTCHours()).toBe(14);
    expect(bkk.getUTCMinutes()).toBe(0);

    // ~24h ahead of NOW (NOW is 10:00 BKK, due is next-day 14:00 → 28h; the date is "tomorrow").
    const hoursAhead = (dueAt!.getTime() - NOW.getTime()) / (60 * 60 * 1000);
    expect(hoursAhead).toBeGreaterThan(24);
    expect(hoursAhead).toBeLessThan(30);

    // Date/time tokens removed, only the task text remains.
    expect(cleanedText).toBe("ประชุม");
    expect(cleanedText).not.toContain("พรุ่งนี้");
    expect(cleanedText).not.toContain("14:00");
  });

  it("plain text (no date) → dueAt null and cleanedText unchanged", () => {
    const { dueAt, cleanedText } = parseThaiDateTime("ซื้อของที่ตลาด", NOW);
    expect(dueAt).toBeNull();
    expect(cleanedText).toBe("ซื้อของที่ตลาด");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// (3) listTodos — FLEX OutboundMessage with quickReply + contiguous 1..N numbering
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("(3) listTodos → Flex message", () => {
  it("returns a type==='flex' message carrying a quickReply, numbered 1..N contiguously", async () => {
    await addTodos(TARGET_ID, ["งานหนึ่ง", "งานสอง", "งานสาม", "งานสี่"], NOW);

    const result = await listTodos(TARGET_ID, NOW);
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.type).toBe("flex");

    // The Flex message itself carries the Quick Reply (LINE spec allows it on any message).
    expect(msg.quickReply).toBeDefined();
    expect(msg.quickReply!.items).toHaveLength(3);
    expect(msg.quickReply!.items.map((i) => i.action.text)).toEqual([
      "ค้าง",
      "วางแผน",
      "ล้างที่เสร็จ",
    ]);

    // Numbering is contiguous 1..N in visible order.
    expect(flexNumbers(result)).toEqual([1, 2, 3, 4]);

    const text = flexText(result);
    expect(text).toContain("รายการงาน");
    expect(text).toContain("ค้าง 4/ทั้งหมด 4");
    expect(text).toContain("งานหนึ่ง");
    expect(text).toContain("งานสี่");
  });

  it("after a delete, remaining tasks renumber 1..N contiguously (no gap)", async () => {
    await addTodos(TARGET_ID, ["งานหนึ่ง", "งานสอง", "งานสาม"], NOW);
    // Remove the middle one (visible #2) — the fake keeps insertion order.
    await deleteTodos(TARGET_ID, { indexes: [2] }, NOW);

    const result = await listTodos(TARGET_ID, NOW);
    expect(flexNumbers(result)).toEqual([1, 2]);

    const text = flexText(result);
    expect(text).toContain("งานหนึ่ง");
    expect(text).toContain("งานสาม");
    expect(text).not.toContain("งานสอง");
  });

  it("is scoped per target — another target's tasks never appear", async () => {
    await addTodos(TARGET_ID, ["ของฉัน"], NOW);
    await addTodos(OTHER_TARGET_ID, ["ของคนอื่น"], NOW);

    const text = flexText(await listTodos(TARGET_ID, NOW));
    expect(text).toContain("ของฉัน");
    expect(text).not.toContain("ของคนอื่น");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// (4) add stores due_at (with date) vs null (without date)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("(4) addTodos due_at persistence", () => {
  it("adding a task WITH a date stores an absolute due_at instant", async () => {
    await addTodos(TARGET_ID, ["ประชุมทีม พรุ่งนี้ 14:00"], NOW);

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("ประชุมทีม"); // date tokens stripped from content
    expect(rows[0].due_at).not.toBeNull();
    // 14:00 Bangkok on the day after NOW == 2026-07-03T07:00:00Z.
    expect(rows[0].due_at).toBe("2026-07-03T07:00:00.000Z");
  });

  it("adding a task WITHOUT a date stores due_at = null", async () => {
    await addTodos(TARGET_ID, ["ซื้อของที่ตลาด"], NOW);

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("ซื้อของที่ตลาด");
    expect(rows[0].due_at).toBeNull();
  });

  it("a multi-line add mixes dated and undated rows correctly", async () => {
    await addTodos(TARGET_ID, ["จ่ายบิล พรุ่งนี้ 14:00", "เดินเล่น"], NOW);

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    expect(rows).toHaveLength(2);
    const bill = rows.find((r) => r.content === "จ่ายบิล");
    const walk = rows.find((r) => r.content === "เดินเล่น");
    expect(bill?.due_at).toBe("2026-07-03T07:00:00.000Z");
    expect(walk?.due_at).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// Engine side-effects: complete / reschedule / clear_done (round-trip through the fake store)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("engine mutations round-trip through the store", () => {
  it("completeTodos (ปิดงาน) marks the visible number done and hides it from the list", async () => {
    await addTodos(TARGET_ID, ["งานหนึ่ง", "งานสอง", "งานสาม"], NOW);

    const result = await completeTodos(TARGET_ID, [2], NOW);
    // Reply = a confirmation text + the refreshed OPEN-only Flex list (done tasks hidden).
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("ปิดงาน");

    const listText = flexText(result);
    expect(listText).toContain("งานหนึ่ง");
    expect(listText).toContain("งานสาม");
    expect(listText).not.toContain("งานสอง"); // done → hidden from ค้าง list

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    expect(rows.find((r) => r.content === "งานสอง")?.done).toBe(true);
    expect(rows.find((r) => r.content === "งานหนึ่ง")?.done).toBe(false);
  });

  it("rescheduleTodo sets due_at from Thai when-text", async () => {
    await addTodos(TARGET_ID, ["งานเอ", "งานบี"], NOW);

    const result = await rescheduleTodo(TARGET_ID, 2, "พรุ่งนี้ 14:00", NOW);
    expect(result[0].type).toBe("flex");

    const bee = store.find((r) => r.target_id === TARGET_ID && r.content === "งานบี");
    expect(bee?.due_at).toBe("2026-07-03T07:00:00.000Z");
  });

  it("clearDone deletes only the done rows, keeps the open ones", async () => {
    await addTodos(TARGET_ID, ["งานหนึ่ง", "งานสอง", "งานสาม"], NOW);
    await completeTodos(TARGET_ID, [1, 3], NOW);

    const result = await clearDone(TARGET_ID, NOW);
    expect(result[0].type).toBe("flex");

    const rows = store.filter((r) => r.target_id === TARGET_ID);
    expect(rows.map((r) => r.content)).toEqual(["งานสอง"]);
  });

  it("deleteTodos({all:true}) empties the target's list", async () => {
    await addTodos(TARGET_ID, ["งานหนึ่ง", "งานสอง"], NOW);
    await addTodos(OTHER_TARGET_ID, ["งานคนอื่น"], NOW);

    const result = await deleteTodos(TARGET_ID, { all: true }, NOW);
    // Empty list → plain-text prompt (not Flex), still with a Quick Reply.
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("ยังไม่มีงานค้าง");
    expect(result[0].quickReply?.items).toHaveLength(3);

    expect(store.filter((r) => r.target_id === TARGET_ID)).toHaveLength(0);
    // Other target untouched.
    expect(store.filter((r) => r.target_id === OTHER_TARGET_ID)).toHaveLength(1);
  });
});
