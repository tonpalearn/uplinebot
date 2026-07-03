import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { validateLedgerToken } from "@/lib/ledger-token";
import { aggregate, periodRange } from "@/lib/modules/expense-tracker/summary";
import { recategorize } from "@/lib/modules/expense-tracker/ledger";
import { listEffectiveCategories } from "@/lib/modules/expense-tracker/category-store";
import type { LedgerKind } from "@/lib/modules/expense-tracker/categories";

// Customer-facing ledger report API — token IS the auth (no admin token). Never prerender:
// every request revalidates the ledger token and scopes all reads/writes to that target.
export const dynamic = "force-dynamic";

/**
 * /api/ledger/[token] — token-gated read of ONE target's upl_ledger_entries + soft-delete.
 *
 * The <token> path segment is `upl_targets.ledger_token` (minted by lib/ledger-token.ts and
 * sent to the customer via the bot's "รายงาน" command). validateLedgerToken(token) resolves it
 * to { targetId, tenantId }; an unknown/empty token → 401. EVERY query below is scoped to the
 * resolved targetId — a targetId is never trusted from the request body, so one token can only
 * ever see/mutate its own chat's entries (per-group isolation preserved).
 *
 *   GET    ?period=day|week|month (default month) → { ok, period, label, summary, entries,
 *                                                     categories:{income,expense} } (dropdowns).
 *   PATCH  { id, category, learn? }                → recategorize IF the row belongs to target.
 *   DELETE { id } (or ?id=)                        → soft-delete IF the row belongs to target.
 */

interface RouteCtx {
  params: { token: string };
}

interface LedgerRow {
  id: string;
  kind: LedgerKind;
  amount: number;
  category: string;
  note: string | null;
  raw_text: string | null;
  occurred_on: string;
  created_at: string;
}

const ENTRY_COLUMNS = "id, kind, amount, category, note, raw_text, occurred_on, created_at";

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

/** Coerce the ?period= param to one of the three valid buckets (default month). */
function parsePeriod(raw: string | null): "day" | "week" | "month" {
  if (raw === "day" || raw === "week") return raw;
  return "month";
}

// ── GET: this target's entries + aggregate for the requested period ──────────────
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateLedgerToken(ctx.params.token);
  if (!auth) return unauthorized();

  const period = parsePeriod(req.nextUrl.searchParams.get("period"));
  const { from, to, label } = periodRange(period, new Date());

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_ledger_entries")
    .select(ENTRY_COLUMNS)
    .eq("target_id", auth.targetId)
    .is("deleted_at", null)
    .gte("occurred_on", from)
    .lte("occurred_on", to)
    .order("occurred_on", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }

  const entries = (data ?? []) as unknown as LedgerRow[];
  const summary = aggregate(entries);

  // ส่ง effective categories ทั้งสอง kind มาด้วย เพื่อให้เว็บเติม dropdown ได้ในรอบเดียว
  const [income, expense] = await Promise.all([
    listEffectiveCategories(auth.targetId, "income"),
    listEffectiveCategories(auth.targetId, "expense"),
  ]);

  return NextResponse.json({
    ok: true,
    period,
    label,
    summary,
    entries,
    categories: { income, expense },
  });
}

// ── PATCH: recategorize an entry that belongs to this target ─────────────────────
export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateLedgerToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: { id?: unknown; category?: unknown; learn?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!id) {
    return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });
  }
  if (!category) {
    return NextResponse.json({ ok: false, reason: "category is required" }, { status: 400 });
  }

  const learn = Boolean(body.learn);
  // recategorize scope ด้วย (id, target_id) เอง — คืน null ถ้าไม่ใช่รายการของ target นี้
  const row = await recategorize(auth.targetId, id, category, learn);
  if (!row) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, entry: row });
}

// ── DELETE: soft-delete an entry that belongs to this target ─────────────────────
export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateLedgerToken(ctx.params.token);
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
  // Scope the soft-delete to BOTH id AND target_id so a token can only touch its own rows.
  const { data, error } = await supabase
    .from("upl_ledger_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("target_id", auth.targetId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }
  if (!data) {
    // No matching (id, target_id, not-already-deleted) row — not found (or not this target's).
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}
