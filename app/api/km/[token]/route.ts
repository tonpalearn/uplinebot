import { NextRequest, NextResponse } from "next/server";
import { validateKmToken } from "@/lib/km-token";
import {
  addEntry,
  addEntries,
  listEntries,
  updateEntry,
  deleteEntry,
  searchKb,
  listUnanswered,
  resolveUnanswered,
} from "@/lib/modules/knowledge-base/store";
import { chunkDocument } from "@/lib/modules/knowledge-base/chunk";

// Customer/admin-facing Knowledge Base API — the <token> IS the auth (no admin session).
// Never prerender: every request revalidates the km token and scopes all reads/writes to that
// tenant. A tenantId is NEVER trusted from the request body — it always comes from the token.
export const dynamic = "force-dynamic";

/**
 * /api/km/[token] — token-gated CRUD over ONE tenant's Knowledge Base (upl_km_entries) + the
 * unanswered queue (upl_km_unanswered). validateKmToken(token) → { tenantId }; unknown → 401.
 *
 *   GET                       → { ok, entries, unanswered }
 *   GET ?q=<query>            → { ok, results: [{id,question,answer,source,score}] }  (test-query preview)
 *   POST { question, answer, keywords?, trigger_keywords? }   → add one entry   → { ok, entry }
 *   POST { document: "<text>" }            → chunk → bulk add         → { ok, added, entries }
 *   PATCH { id, question?, answer?, keywords?, trigger_keywords?, enabled? }   → { ok, entry }
 *   PATCH { unansweredId, answer, question? } → resolve into an entry → { ok, entry }
 *   DELETE { id } (or ?id=)                → delete an entry          → { ok, id }
 */

interface RouteCtx {
  params: { token: string };
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

// ── GET: full KB + unanswered queue, OR a ?q= retrieval preview ───────────────────
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateKmToken(ctx.params.token);
  if (!auth) return unauthorized();

  const q = req.nextUrl.searchParams.get("q");
  if (q !== null) {
    // "ทดสอบคำถาม" — โชว์ว่าบอทจะดึงอะไรมาตอบ (พร้อมคะแนน)
    const results = await searchKb(auth.tenantId, q);
    return NextResponse.json({ ok: true, query: q, results });
  }

  const [entries, unanswered] = await Promise.all([
    listEntries(auth.tenantId),
    listUnanswered(auth.tenantId),
  ]);
  return NextResponse.json({ ok: true, entries, unanswered });
}

// ── POST: add one entry, OR chunk a pasted document into many ─────────────────────
export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateKmToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: {
    question?: unknown;
    answer?: unknown;
    keywords?: unknown;
    trigger_keywords?: unknown;
    document?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  // วางเอกสาร → แตกเป็นความรู้หลายรายการ
  if (typeof body.document === "string") {
    const chunks = chunkDocument(body.document);
    if (chunks.length === 0) {
      return NextResponse.json({ ok: false, reason: "no_chunks" }, { status: 400 });
    }
    const inserted = await addEntries(
      auth.tenantId,
      chunks.map((c) => ({ ...c, source: "document" }))
    );
    return NextResponse.json({ ok: true, added: inserted.length, entries: inserted });
  }

  // เพิ่มความรู้ทีละรายการ
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  const keywords = typeof body.keywords === "string" ? body.keywords.trim() : undefined;
  const trigger_keywords =
    typeof body.trigger_keywords === "string" ? body.trigger_keywords.trim() : undefined;
  if (!question || !answer) {
    return NextResponse.json(
      { ok: false, reason: "question and answer are required" },
      { status: 400 }
    );
  }

  const entry = await addEntry(auth.tenantId, {
    question,
    answer,
    keywords,
    trigger_keywords,
    source: "manual",
  });
  return NextResponse.json({ ok: true, entry });
}

// ── PATCH: edit an entry, OR resolve an unanswered question into an entry ──────────
export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateKmToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: {
    id?: unknown;
    question?: unknown;
    answer?: unknown;
    keywords?: unknown;
    trigger_keywords?: unknown;
    enabled?: unknown;
    unansweredId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  // แก้คิว "ตอบไม่ได้" → สร้างความรู้จากคำถามนั้น + mark resolved
  if (typeof body.unansweredId === "string") {
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!answer) {
      return NextResponse.json({ ok: false, reason: "answer is required" }, { status: 400 });
    }
    // ต้องมีคำถาม — จาก body.question (ถ้าแอดมินแก้) หรือคิวเดิม (client ส่งมาให้)
    if (!question) {
      return NextResponse.json({ ok: false, reason: "question is required" }, { status: 400 });
    }
    const entry = await addEntry(auth.tenantId, { question, answer, source: "manual" });
    await resolveUnanswered(body.unansweredId, auth.tenantId);
    return NextResponse.json({ ok: true, entry });
  }

  // แก้ไขความรู้เดิม
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });
  }
  const patch: {
    question?: string;
    answer?: string;
    keywords?: string | null;
    trigger_keywords?: string | null;
    enabled?: boolean;
  } = {};
  if (typeof body.question === "string") patch.question = body.question;
  if (typeof body.answer === "string") patch.answer = body.answer;
  if (typeof body.keywords === "string") patch.keywords = body.keywords;
  if (typeof body.trigger_keywords === "string") patch.trigger_keywords = body.trigger_keywords;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, reason: "no fields to update" }, { status: 400 });
  }

  const entry = await updateEntry(id, auth.tenantId, patch);
  if (!entry) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, entry });
}

// ── DELETE: remove an entry that belongs to this tenant ───────────────────────────
export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateKmToken(ctx.params.token);
  if (!auth) return unauthorized();

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

  const removed = await deleteEntry(id, auth.tenantId);
  if (!removed) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
