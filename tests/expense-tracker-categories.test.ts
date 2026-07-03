import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the per-target category customization merge logic in
 * lib/modules/expense-tracker/category-store.ts — specifically `listEffectiveCategories`,
 * which is the one piece of that file with real (pure-ish) logic worth asserting:
 * it merges the built-in defaults (categories.ts) with per-target override/custom rows.
 *
 * category-store.ts is DB-backed (getServiceClient() → upl_ledger_categories), so we reuse
 * the repo's established Supabase-mock pattern (see tests/todo-engine.test.ts): vi.mock the
 * lib/db module boundary with an in-memory fake that mimics the ONE PostgREST chain
 * listEffectiveCategories uses:
 *
 *   from("upl_ledger_categories").select(cols).eq("target_id", id).eq("kind", kind)  → { data, error }
 *
 * We seed the fake `upl_ledger_categories` store directly (rather than driving writes through
 * addCategory/setCategoryHidden) so the merge rules are asserted in isolation:
 *   1) built-ins are all present, in order, when there are no rows
 *   2) a `hidden` override flags the built-in as hidden (except "อื่นๆ", which is forced visible)
 *   3) a custom row (is_custom=true) is appended after the built-ins
 *   4) an emoji override on a built-in wins over the default emoji
 *
 * The WRITE paths (addCategory / setCategoryHidden / updateCategory / deleteCategory) also do
 * upsert/delete/entry-migration against Supabase; those are covered by the maintainer's live
 * prod verification, not unit-tested here (see the report note). This file locks down the
 * read-side merge contract only.
 */

// ── In-memory fake upl_ledger_categories store ───────────────────────────────────────────────

interface FakeCategoryRow {
  id: string;
  target_id: string;
  name: string;
  kind: "income" | "expense";
  emoji: string | null;
  sort: number | null;
  hidden: boolean;
  is_custom: boolean;
}

let store: FakeCategoryRow[] = [];
let idCounter = 0;

function seed(row: Partial<FakeCategoryRow> & Pick<FakeCategoryRow, "name" | "kind">): void {
  idCounter += 1;
  store.push({
    id: `cat-${idCounter}`,
    target_id: row.target_id ?? "target-1",
    name: row.name,
    kind: row.kind,
    emoji: row.emoji ?? null,
    sort: row.sort ?? null,
    hidden: row.hidden ?? false,
    is_custom: row.is_custom ?? false,
  });
}

function makeFakeSupabase() {
  function fromTable(table: string) {
    if (table === "upl_ledger_categories") return categoriesBuilder();
    // The functions under test in this file only ever read upl_ledger_categories.
    throw new Error(`Fake Supabase client does not support table "${table}"`);
  }

  function categoriesBuilder() {
    let eqTargetId: string | null = null;
    let eqKind: string | null = null;

    function resolve(): { data: FakeCategoryRow[]; error: null } {
      let rows = store.slice();
      if (eqTargetId !== null) rows = rows.filter((r) => r.target_id === eqTargetId);
      if (eqKind !== null) rows = rows.filter((r) => r.kind === eqKind);
      return { data: rows, error: null };
    }

    const builder: any = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        if (column === "target_id") eqTargetId = value as string;
        if (column === "kind") eqKind = value as string;
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
const { listEffectiveCategories } = await import("../lib/modules/expense-tracker/category-store");
const { EXPENSE_CATEGORIES, INCOME_CATEGORIES, CATEGORY_EMOJI } = await import(
  "../lib/modules/expense-tracker/categories"
);

const TARGET = "target-1";

beforeEach(() => {
  store = [];
  idCounter = 0;
});

// ── merge rule 1: built-ins present when there are no customization rows ──────────────────────

describe("listEffectiveCategories — built-in defaults (no rows)", () => {
  it("expense: returns all built-ins in order, none hidden, all isCustom=false", async () => {
    const list = await listEffectiveCategories(TARGET, "expense");
    expect(list.map((c) => c.name)).toEqual([...EXPENSE_CATEGORIES]);
    expect(list.every((c) => c.hidden === false)).toBe(true);
    expect(list.every((c) => c.isCustom === false)).toBe(true);
    // default emoji comes from CATEGORY_EMOJI
    const กิน = list.find((c) => c.name === "กิน");
    expect(กิน?.emoji).toBe(CATEGORY_EMOJI["กิน"]);
  });

  it("income: returns all built-ins in order", async () => {
    const list = await listEffectiveCategories(TARGET, "income");
    expect(list.map((c) => c.name)).toEqual([...INCOME_CATEGORIES]);
  });

  it("'อื่นๆ' (fallback) is always present in both kinds", async () => {
    const exp = await listEffectiveCategories(TARGET, "expense");
    const inc = await listEffectiveCategories(TARGET, "income");
    expect(exp.some((c) => c.name === "อื่นๆ")).toBe(true);
    expect(inc.some((c) => c.name === "อื่นๆ")).toBe(true);
  });
});

// ── merge rule 2: hidden override ────────────────────────────────────────────────────────────

describe("listEffectiveCategories — hidden override", () => {
  it("a hidden=true row flags that built-in as hidden (still present in the full list)", async () => {
    seed({ name: "บันเทิง", kind: "expense", hidden: true });
    const list = await listEffectiveCategories(TARGET, "expense");
    const บันเทิง = list.find((c) => c.name === "บันเทิง");
    expect(บันเทิง).toBeDefined();
    expect(บันเทิง?.hidden).toBe(true);
    // all OTHER built-ins remain visible
    expect(list.filter((c) => c.name !== "บันเทิง").every((c) => c.hidden === false)).toBe(true);
    // full built-in set is still returned (list view keeps hidden ones so a UI can un-hide)
    expect(list.map((c) => c.name)).toEqual([...EXPENSE_CATEGORIES]);
  });

  it("'อื่นๆ' is NEVER hidden even if a hidden=true row exists for it", async () => {
    // categorizeLocal falls back to "อื่นๆ", so the store forces it visible regardless.
    seed({ name: "อื่นๆ", kind: "expense", hidden: true });
    const list = await listEffectiveCategories(TARGET, "expense");
    const other = list.find((c) => c.name === "อื่นๆ");
    expect(other).toBeDefined();
    expect(other?.hidden).toBe(false);
  });
});

// ── merge rule 3: custom row appended ────────────────────────────────────────────────────────

describe("listEffectiveCategories — custom rows", () => {
  it("a custom row (is_custom=true) is appended after the built-ins", async () => {
    seed({ name: "ทำบุญ", kind: "expense", is_custom: true });
    const list = await listEffectiveCategories(TARGET, "expense");
    const custom = list.find((c) => c.name === "ทำบุญ");
    expect(custom).toBeDefined();
    expect(custom?.isCustom).toBe(true);
    // all built-ins still present…
    for (const name of EXPENSE_CATEGORIES) {
      expect(list.some((c) => c.name === name)).toBe(true);
    }
    // …and the custom one comes after the last built-in when sort is unset (sort defaults high).
    const lastBuiltInIdx = Math.max(
      ...EXPENSE_CATEGORIES.map((n) => list.findIndex((c) => c.name === n))
    );
    const customIdx = list.findIndex((c) => c.name === "ทำบุญ");
    expect(customIdx).toBeGreaterThan(lastBuiltInIdx);
  });

  it("custom row uses its own emoji when provided", async () => {
    seed({ name: "ทำบุญ", kind: "expense", is_custom: true, emoji: "🙏" });
    const list = await listEffectiveCategories(TARGET, "expense");
    expect(list.find((c) => c.name === "ทำบุญ")?.emoji).toBe("🙏");
  });
});

// ── merge rule 4: emoji override on a built-in wins ──────────────────────────────────────────

describe("listEffectiveCategories — emoji override", () => {
  it("an emoji override on a built-in replaces the default emoji", async () => {
    const original = CATEGORY_EMOJI["กิน"];
    seed({ name: "กิน", kind: "expense", emoji: "🍕" });
    const list = await listEffectiveCategories(TARGET, "expense");
    const กิน = list.find((c) => c.name === "กิน");
    expect(กิน?.emoji).toBe("🍕");
    expect(กิน?.emoji).not.toBe(original);
    // overriding emoji alone does not hide the category
    expect(กิน?.hidden).toBe(false);
    expect(กิน?.isCustom).toBe(false);
  });

  it("built-in with NO override row falls back to CATEGORY_EMOJI default", async () => {
    seed({ name: "กิน", kind: "expense", emoji: "🍕" }); // override only กิน
    const list = await listEffectiveCategories(TARGET, "expense");
    // เดินทาง has no row → default emoji
    expect(list.find((c) => c.name === "เดินทาง")?.emoji).toBe(CATEGORY_EMOJI["เดินทาง"]);
  });
});

// ── scoping: rows of another target / another kind must not leak ──────────────────────────────

describe("listEffectiveCategories — target + kind scoping", () => {
  it("a custom row for a DIFFERENT target does not appear", async () => {
    seed({ name: "ของคนอื่น", kind: "expense", is_custom: true, target_id: "someone-else" });
    const list = await listEffectiveCategories(TARGET, "expense");
    expect(list.some((c) => c.name === "ของคนอื่น")).toBe(false);
    // and the default built-in set is intact
    expect(list.map((c) => c.name)).toEqual([...EXPENSE_CATEGORIES]);
  });

  it("an income custom row does not leak into the expense list", async () => {
    seed({ name: "ค่าเช่ารับ", kind: "income", is_custom: true });
    const expList = await listEffectiveCategories(TARGET, "expense");
    expect(expList.some((c) => c.name === "ค่าเช่ารับ")).toBe(false);
    const incList = await listEffectiveCategories(TARGET, "income");
    expect(incList.some((c) => c.name === "ค่าเช่ารับ")).toBe(true);
  });
});
