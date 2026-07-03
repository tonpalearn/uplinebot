import { NextRequest, NextResponse } from "next/server";
import { validateLedgerToken } from "@/lib/ledger-token";
import {
  listEffectiveCategories,
  addCategory,
  setCategoryHidden,
  updateCategory,
  deleteCategory,
} from "@/lib/modules/expense-tracker/category-store";
import type { LedgerKind } from "@/lib/modules/expense-tracker/categories";

// Customer-facing category management API — token IS the auth (no admin token). Never
// prerender: every request revalidates the ledger token and scopes all reads/writes to that
// target (mirrors /api/ledger/[token]/route.ts). One token can only ever see/mutate its own
// chat's category customization (per-group isolation preserved by category-store.ts).
export const dynamic = "force-dynamic";

/**
 * /api/ledger/[token]/categories — token-gated CRUD over ONE target's category customization
 * (upl_ledger_categories). The stored strings on existing entries are NOT touched here except
 * when a rename/delete migrates them (handled inside category-store.ts).
 *
 *   GET    ?kind=income|expense (omit → both)          → { ok, categories }.
 *   POST   { kind, name, emoji? }                       → addCategory.
 *   PATCH  { kind, name, hidden?, emoji?, newName?, sort? } → setCategoryHidden / updateCategory.
 *   DELETE { kind, name } (or ?kind=&name=)             → deleteCategory (custom only).
 *
 * Every mutation returns { ok:true, categories:<fresh effective list for that kind> } so the UI
 * can refresh in place. Unknown token → 401 { ok:false, reason:"invalid_token" } (same shape as
 * the sibling route). Bad input → 400; category-store errors (e.g. hide "อื่นๆ") → 400 too.
 */

interface RouteCtx {
  params: { token: string };
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

/** Coerce a request-supplied kind into a valid LedgerKind, or null if missing/invalid. */
function parseKind(raw: unknown): LedgerKind | null {
  if (raw === "income" || raw === "expense") return raw;
  return null;
}

// ── GET: this target's effective categories (one kind, or both) ──────────────────
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateLedgerToken(ctx.params.token);
  if (!auth) return unauthorized();

  const kindParam = req.nextUrl.searchParams.get("kind");
  try {
    if (kindParam === "income" || kindParam === "expense") {
      const list = await listEffectiveCategories(auth.targetId, kindParam);
      return NextResponse.json({ ok: true, categories: list });
    }
    // ไม่ระบุ kind → คืนทั้งสอง (income + expense)
    const [income, expense] = await Promise.all([
      listEffectiveCategories(auth.targetId, "income"),
      listEffectiveCategories(auth.targetId, "expense"),
    ]);
    return NextResponse.json({ ok: true, categories: { income, expense } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// ── POST: add a custom category (or unhide a matching built-in) ───────────────────
export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateLedgerToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: { kind?: unknown; name?: unknown; emoji?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const kind = parseKind(body.kind);
  if (!kind) {
    return NextResponse.json({ ok: false, reason: "kind is required" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ ok: false, reason: "name is required" }, { status: 400 });
  }
  const emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim() : undefined;

  try {
    const categories = await addCategory(auth.targetId, kind, name, emoji);
    return NextResponse.json({ ok: true, categories });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

// ── PATCH: hide/unhide OR edit (emoji / rename / sort) ────────────────────────────
export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateLedgerToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: {
    kind?: unknown;
    name?: unknown;
    hidden?: unknown;
    emoji?: unknown;
    newName?: unknown;
    sort?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const kind = parseKind(body.kind);
  if (!kind) {
    return NextResponse.json({ ok: false, reason: "kind is required" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ ok: false, reason: "name is required" }, { status: 400 });
  }

  try {
    // hidden → setCategoryHidden; อย่างอื่น (emoji/newName/sort) → updateCategory
    if (body.hidden !== undefined) {
      const categories = await setCategoryHidden(auth.targetId, kind, name, Boolean(body.hidden));
      return NextResponse.json({ ok: true, categories });
    }

    const patch: { emoji?: string; newName?: string; sort?: number } = {};
    if (body.emoji !== undefined) patch.emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";
    if (body.newName !== undefined) patch.newName = typeof body.newName === "string" ? body.newName : "";
    if (body.sort !== undefined) {
      const n = Number(body.sort);
      if (Number.isFinite(n)) patch.sort = Math.trunc(n);
    }

    if (patch.emoji === undefined && patch.newName === undefined && patch.sort === undefined) {
      return NextResponse.json(
        { ok: false, reason: "no updatable fields provided" },
        { status: 400 }
      );
    }

    const categories = await updateCategory(auth.targetId, kind, name, patch);
    return NextResponse.json({ ok: true, categories });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

// ── DELETE: remove a custom category (reassign its entries to "อื่นๆ") ─────────────
export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateLedgerToken(ctx.params.token);
  if (!auth) return unauthorized();

  // kind/name may arrive as query params or in the JSON body.
  let kindRaw: unknown = req.nextUrl.searchParams.get("kind");
  let name = req.nextUrl.searchParams.get("name") ?? "";
  if (!kindRaw || !name) {
    try {
      const body = (await req.json()) as { kind?: unknown; name?: unknown };
      if (!kindRaw) kindRaw = body.kind;
      if (!name && typeof body.name === "string") name = body.name;
    } catch {
      // no body — fall through to the validation below
    }
  }

  const kind = parseKind(kindRaw);
  if (!kind) {
    return NextResponse.json({ ok: false, reason: "kind is required" }, { status: 400 });
  }
  name = name.trim();
  if (!name) {
    return NextResponse.json({ ok: false, reason: "name is required" }, { status: 400 });
  }

  try {
    const categories = await deleteCategory(auth.targetId, kind, name);
    return NextResponse.json({ ok: true, categories });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
