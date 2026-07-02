import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * /api/plan/[token] — token-gated CRUD over ONE target's upl_todos.
 *
 * These tests mock lib/db with a tiny in-memory Supabase query builder that serves BOTH
 * tables the route path touches:
 *   - upl_targets: reverse-lookup by plan_token → { id, upl_bots:{tenant_id} }, exactly the
 *     shape lib/plan-token.validatePlanToken() reads. (validatePlanToken runs for real.)
 *   - upl_todos:   rows scoped by target_id, mirroring the .eq("target_id", …) filters the
 *     handlers apply so we can prove per-target (cross-tenant) isolation.
 *
 * NextRequest objects are constructed directly and the Next 14 route handlers are called with
 * a second arg of { params: { token } } — the same context object the App Router passes.
 */

// ── In-memory fixtures ──────────────────────────────────────────────────────────────────
// Two targets in two tenants. Each valid plan_token maps to exactly one target.
const TARGETS = [
  { id: "target-A", plan_token: "token-A", tenant_id: "tenant-A" },
  { id: "target-B", plan_token: "token-B", tenant_id: "tenant-B" },
];

// upl_todos seed — todo-1 belongs to target-A, todo-2 belongs to target-B.
type Todo = {
  id: string;
  target_id: string;
  content: string;
  done: boolean;
  due_at: string | null;
  sort_order: number | null;
  reminded_at: string | null;
  created_at: string;
};

let todos: Todo[] = [];

function seedTodos(): Todo[] {
  return [
    {
      id: "todo-1",
      target_id: "target-A",
      content: "A's task",
      done: false,
      due_at: null,
      sort_order: null,
      reminded_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
    },
    {
      id: "todo-2",
      target_id: "target-B",
      content: "B's task",
      done: false,
      due_at: null,
      sort_order: null,
      reminded_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
    },
  ];
}

let idCounter = 0;

// ── Mock lib/db ─────────────────────────────────────────────────────────────────────────
// A minimal Supabase-like builder. `filters` accumulates .eq() constraints; terminal methods
// (.maybeSingle/.single or awaiting the builder after .order()) resolve against the fixtures.
vi.mock("../lib/db", () => {
  function makeBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" | "update" | "delete" = "select";
    let insertRow: Record<string, unknown> | null = null;
    let updatePatch: Record<string, unknown> | null = null;

    function matchTodos(): Todo[] {
      return todos.filter((t) => {
        if (filters.id !== undefined && t.id !== filters.id) return false;
        if (filters.target_id !== undefined && t.target_id !== filters.target_id) return false;
        return true;
      });
    }

    // Resolve a SELECT list on upl_todos (the GET path awaits the builder after .order()).
    function resolveList(): { data: unknown; error: null } {
      return { data: matchTodos().map((t) => ({ ...t })), error: null };
    }

    // Resolve the single-row terminal for whichever op is active.
    function resolveSingle(): { data: unknown; error: null } {
      if (table === "upl_targets") {
        // validatePlanToken: .select("id, upl_bots(tenant_id)").eq("plan_token", …)
        const row = TARGETS.find((t) => t.plan_token === filters.plan_token);
        if (!row) return { data: null, error: null };
        return { data: { id: row.id, upl_bots: { tenant_id: row.tenant_id } }, error: null };
      }

      // upl_todos
      if (op === "insert") {
        const created: Todo = {
          id: `todo-new-${++idCounter}`,
          target_id: String(insertRow?.target_id ?? ""),
          content: String(insertRow?.content ?? ""),
          done: false,
          due_at: (insertRow?.due_at as string | null) ?? null,
          sort_order: null,
          reminded_at: null,
          created_at: "2026-07-02T00:00:00.000Z",
        };
        todos.push(created);
        return { data: { ...created }, error: null };
      }

      if (op === "update") {
        const [hit] = matchTodos();
        if (!hit) return { data: null, error: null }; // no (id,target_id) match → handler 404s
        Object.assign(hit, updatePatch);
        return { data: { ...hit }, error: null };
      }

      if (op === "delete") {
        const [hit] = matchTodos();
        if (!hit) return { data: null, error: null };
        todos = todos.filter((t) => t !== hit);
        return { data: { id: hit.id }, error: null };
      }

      // plain select single (unused by these paths but supported)
      const [hit] = matchTodos();
      return { data: hit ? { ...hit } : null, error: null };
    }

    const builder: any = {
      select: () => builder,
      insert: (row: Record<string, unknown>) => {
        op = "insert";
        insertRow = row;
        return builder;
      },
      update: (patch: Record<string, unknown>) => {
        op = "update";
        updatePatch = patch;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      // GET awaits the builder right after .order(); make .order() resolve the list.
      order: () => Promise.resolve(resolveList()),
      maybeSingle: async () => resolveSingle(),
      single: async () => resolveSingle(),
    };
    return builder;
  }

  return { getServiceClient: () => ({ from: (t: string) => makeBuilder(t) }) };
});

// Import AFTER the mock is registered.
import { GET, POST, PATCH, DELETE } from "../app/api/plan/[token]/route";

// ── Request + ctx helpers ────────────────────────────────────────────────────────────────
const BASE = "https://uplinebot-cyan.vercel.app";

function ctx(token: string) {
  return { params: { token } };
}

function getReq(token: string): NextRequest {
  return new NextRequest(`${BASE}/api/plan/${token}`, { method: "GET" });
}

function jsonReq(method: "POST" | "PATCH" | "DELETE", token: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE}/api/plan/${token}`, {
    method,
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  todos = seedTodos();
  idCounter = 0;
});

// ── (1) invalid / missing token → 401 invalid_token on GET ───────────────────────────────
describe("GET /api/plan/[token] — token auth", () => {
  it("401 invalid_token for an unknown token", async () => {
    const res = await GET(getReq("nope"), ctx("nope"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("401 invalid_token for a missing (empty) token", async () => {
    const res = await GET(getReq(""), ctx(""));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_token" });
  });
});

// ── (2) valid token GET returns ONLY that target's todos ─────────────────────────────────
describe("GET /api/plan/[token] — per-target read scoping", () => {
  it("returns only token-A's todos (not token-B's)", async () => {
    const res = await GET(getReq("token-A"), ctx("token-A"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.todos.map((t: { id: string }) => t.id)).toEqual(["todo-1"]);
    expect(body.todos.every((t: { content: string }) => t.content === "A's task")).toBe(true);
  });

  it("token-B sees only its own todo", async () => {
    const res = await GET(getReq("token-B"), ctx("token-B"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.todos.map((t: { id: string }) => t.id)).toEqual(["todo-2"]);
  });
});

// ── (3) POST with valid token inserts scoped to the token's target; empty content → 400 ──
describe("POST /api/plan/[token] — scoped insert + validation", () => {
  it("inserts a todo scoped to the token's target_id (never from the body)", async () => {
    // Body even tries to smuggle a foreign target_id; handler must ignore it.
    const res = await POST(
      jsonReq("POST", "token-A", { content: "  new task  ", target_id: "target-B" }),
      ctx("token-A")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.todo.target_id).toBe("target-A"); // scoped to the token, not the body
    expect(body.todo.content).toBe("new task"); // trimmed

    // The new row is visible under target-A and NOT under target-B.
    expect(todos.filter((t) => t.target_id === "target-A")).toHaveLength(2);
    expect(todos.filter((t) => t.target_id === "target-B")).toHaveLength(1);
  });

  it("400 when content is empty / whitespace-only", async () => {
    const res = await POST(jsonReq("POST", "token-A", { content: "   " }), ctx("token-A"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "content is required" });
  });

  it("401 invalid_token before any insert when token is bad", async () => {
    const res = await POST(jsonReq("POST", "bad", { content: "x" }), ctx("bad"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_token" });
  });
});

// ── (4) PATCH / DELETE of another target's todo → 404 (cross-tenant isolation) ───────────
describe("PATCH/DELETE /api/plan/[token] — cross-tenant isolation", () => {
  it("PATCH of todo-2 (target-B) via token-A → 404 not_found, row unchanged", async () => {
    const res = await PATCH(
      jsonReq("PATCH", "token-A", { id: "todo-2", content: "hijacked" }),
      ctx("token-A")
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, reason: "not_found" });
    // todo-2 must be untouched.
    expect(todos.find((t) => t.id === "todo-2")?.content).toBe("B's task");
  });

  it("PATCH of the token's OWN todo succeeds (control)", async () => {
    const res = await PATCH(
      jsonReq("PATCH", "token-A", { id: "todo-1", done: true }),
      ctx("token-A")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.todo.done).toBe(true);
  });

  it("DELETE of todo-2 (target-B) via token-A → 404 not_found, row still present", async () => {
    const res = await DELETE(
      jsonReq("DELETE", "token-A", { id: "todo-2" }),
      ctx("token-A")
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, reason: "not_found" });
    expect(todos.some((t) => t.id === "todo-2")).toBe(true);
  });

  it("DELETE of the token's OWN todo succeeds (control)", async () => {
    const res = await DELETE(
      jsonReq("DELETE", "token-A", { id: "todo-1" }),
      ctx("token-A")
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "todo-1" });
    expect(todos.some((t) => t.id === "todo-1")).toBe(false);
  });
});
