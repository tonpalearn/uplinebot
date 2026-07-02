import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { validatePlanToken } from "@/lib/plan-token";

// Customer-facing planner API — token IS the auth (no admin token). Never prerender:
// every request revalidates the plan token and scopes all reads/writes to that target.
export const dynamic = "force-dynamic";

/**
 * /api/plan/[token] — token-gated CRUD over ONE target's upl_todos.
 *
 * The <token> path segment is `upl_targets.plan_token` (minted by lib/plan-token.ts and
 * sent to the customer via the bot's "วางแผน" command). validatePlanToken(token) resolves
 * it to { targetId, tenantId }; an unknown/empty token → 401. EVERY query below is scoped
 * to the resolved targetId — a targetId is never trusted from the request body, so one
 * token can only ever see/mutate its own chat's tasks (per-group isolation preserved).
 *
 *   GET    → { ok, todos:[{id,content,done,due_at,sort_order,created_at}] } (chat-list order).
 *   POST   { content, due_at? }                       → insert (400 if content empty).
 *   PATCH  { id, content?, due_at?, done?, sort_order? } → update IF row belongs to target, else 404.
 *   DELETE { id }                                     → delete IF row belongs to target, else 404.
 */

interface RouteCtx {
  params: { token: string };
}

interface TodoRow {
  id: string;
  content: string;
  done: boolean;
  due_at: string | null;
  sort_order: number | null;
  created_at: string;
}

const TODO_COLUMNS = "id, content, done, due_at, sort_order, created_at";

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

/** coalesce(sort_order, epoch(created_at)) ascending — mirrors the chat list ordering. */
function sortTodos(rows: TodoRow[]): TodoRow[] {
  return rows.slice().sort((a, b) => {
    const ka = a.sort_order ?? epochSeconds(a.created_at);
    const kb = b.sort_order ?? epochSeconds(b.created_at);
    if (ka !== kb) return ka - kb;
    return a.created_at.localeCompare(b.created_at);
  });
}

function epochSeconds(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * Normalize a client-supplied due_at into an ISO string, null (explicit clear), or
 * undefined (not provided → leave unchanged). Accepts a full ISO / datetime-local string;
 * anything unparseable is treated as a clear so the caller never persists garbage.
 */
function normalizeDueAt(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// ── GET: list this target's todos ────────────────────────────────────────────────────────
export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validatePlanToken(ctx.params.token);
  if (!auth) return unauthorized();

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_todos")
    .select(TODO_COLUMNS)
    .eq("target_id", auth.targetId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }

  const todos = sortTodos((data ?? []) as TodoRow[]);
  return NextResponse.json({ ok: true, todos });
}

// ── POST: add a todo to this target ──────────────────────────────────────────────────────
export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validatePlanToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: { content?: unknown; due_at?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ ok: false, reason: "content is required" }, { status: 400 });
  }

  const dueAt = normalizeDueAt(body.due_at);

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_todos")
    // target_id ALWAYS comes from the validated token, never from the body.
    .insert({ target_id: auth.targetId, content, due_at: dueAt ?? null })
    .select(TODO_COLUMNS)
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, reason: error?.message ?? "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, todo: data as TodoRow });
}

// ── PATCH: update a todo that belongs to this target ─────────────────────────────────────
export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validatePlanToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: {
    id?: unknown;
    content?: unknown;
    due_at?: unknown;
    done?: unknown;
    sort_order?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};

  if (body.content !== undefined) {
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return NextResponse.json({ ok: false, reason: "content cannot be empty" }, { status: 400 });
    }
    patch.content = content;
  }

  if (body.due_at !== undefined) {
    const dueAt = normalizeDueAt(body.due_at);
    patch.due_at = dueAt ?? null;
    // Changing the due time re-arms the reminder (mirror rescheduleTodo in todo.ts).
    patch.reminded_at = null;
  }

  if (body.done !== undefined) {
    patch.done = Boolean(body.done);
  }

  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    patch.sort_order = Number.isFinite(n) ? Math.trunc(n) : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, reason: "no updatable fields provided" }, { status: 400 });
  }

  const supabase = getServiceClient();
  // Scope the update to BOTH id AND target_id so a token can only touch its own rows.
  const { data, error } = await supabase
    .from("upl_todos")
    .update(patch)
    .eq("id", id)
    .eq("target_id", auth.targetId)
    .select(TODO_COLUMNS)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }
  if (!data) {
    // No row matched the (id, target_id) pair — not found (or not this target's).
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, todo: data as TodoRow });
}

// ── DELETE: delete a todo that belongs to this target ────────────────────────────────────
export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validatePlanToken(ctx.params.token);
  if (!auth) return unauthorized();

  // id may arrive in the JSON body or as a ?id= query param.
  let id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) {
    try {
      const body = (await req.json()) as { id?: unknown };
      if (typeof body.id === "string") id = body.id;
    } catch {
      // no body — fall through to the empty-id check
    }
  }

  if (!id) {
    return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_todos")
    .delete()
    .eq("id", id)
    .eq("target_id", auth.targetId)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}
