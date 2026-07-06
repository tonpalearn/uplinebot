import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { decodeSlip } from "@/lib/payments/slip-decode";
import { ocrSlipAmount } from "@/lib/payments/slip-ocr";
import { PUBLIC_SUB_COLUMNS, type SubscriptionRow } from "@/lib/subscriptions";

/**
 * Self-serve slip verification (Phase 1) — the customer uploads their PromptPay transfer slip
 * and we activate the subscription automatically, with NO paid slip API.
 *
 * We decode the QR embedded in the slip ourselves (see lib/payments/slip-decode.ts) and use
 * three independent anti-replay keys — the raw QR string, a sha256 of the image bytes, and the
 * parsed transaction reference — so the same slip can never activate two subscriptions.
 *
 * Auth: the subscription's manage_token (or its payment_ref) IS the authorization, matching the
 * rest of the /api/subscribe flow. All money/state logic runs server-side with the service role;
 * client-sent amounts are never trusted. Runs on the default Node runtime (sharp needs it).
 */
export const dynamic = "force-dynamic";
// OCR on a cold start can be slow; give the function room on Pro. Harmless on Hobby (capped at
// 10s) — ocrSlipAmount races an internal ~8s timeout so we degrade to manual before any 504.
export const maxDuration = 60;

// Reject oversized uploads before we spend CPU decoding. ~5MB of raw bytes.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Strip a data-URL prefix if present, then decode base64 → Buffer. Returns null if unusable. */
function decodeImageInput(image: unknown): Buffer | null {
  if (typeof image !== "string" || image.trim().length === 0) return null;
  // Accept both a raw base64 string and a data URL (data:image/png;base64,....).
  const commaIdx = image.indexOf(",");
  const b64 = image.startsWith("data:") && commaIdx >= 0 ? image.slice(commaIdx + 1) : image;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { token?: unknown; ref?: unknown; image?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  if (!token && !ref) {
    return NextResponse.json({ ok: false, reason: "token or ref is required" }, { status: 400 });
  }

  // Guard the raw base64 length first (fast, no allocation of the decoded buffer yet).
  if (typeof body.image === "string" && body.image.length > MAX_IMAGE_BYTES * 2) {
    return NextResponse.json({ ok: false, reason: "image_too_large" }, { status: 413 });
  }
  const image = decodeImageInput(body.image);
  if (!image) return NextResponse.json({ ok: false, reason: "image is required" }, { status: 400 });
  if (image.length > MAX_IMAGE_BYTES) {
    return NextResponse.json({ ok: false, reason: "image_too_large" }, { status: 413 });
  }

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "server_misconfigured" },
      { status: 500 }
    );
  }

  // ── Load the subscription (by manage_token, else payment_ref) ────────────────────────────
  const lookup = supabase.from("upl_customer_subscriptions").select(PUBLIC_SUB_COLUMNS);
  const { data: subData, error: subErr } = await (token
    ? lookup.eq("manage_token", token)
    : lookup.eq("payment_ref", ref)
  ).maybeSingle();

  if (subErr) return NextResponse.json({ ok: false, reason: subErr.message }, { status: 500 });
  if (!subData) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });

  const sub = subData as unknown as SubscriptionRow;

  // Idempotent: an already-active sub returns ok without re-processing the slip.
  if (sub.status === "active") {
    return NextResponse.json({ ok: true, alreadyActive: true, subscription: sub });
  }
  // Only a pending subscription can be activated by a slip.
  if (sub.status !== "pending") {
    return NextResponse.json({ ok: false, reason: "not_pending", status: sub.status }, { status: 409 });
  }

  // ── Decode the slip (never throws) ───────────────────────────────────────────────────────
  const decoded = await decodeSlip(image);

  // No QR → do NOT activate; hand off to manual review.
  if (!decoded.foundQr) {
    return NextResponse.json({ ok: false, reason: "no_qr", needsManual: true });
  }

  // ── Multi-layer anti-replay: reject if this slip matches ANY existing row ─────────────────
  // (a) same raw QR, (b) same image hash, (c) same transRef (when parsed).
  // foundQr is true here, so rawQr is non-null.
  const rawQr = decoded.rawQr as string;
  const orClauses = [`raw_qr.eq.${encodeOrValue(rawQr)}`, `image_hash.eq.${encodeOrValue(decoded.imageHash)}`];
  if (decoded.transRef) orClauses.push(`trans_ref.eq.${encodeOrValue(decoded.transRef)}`);

  const { data: dupRows, error: dupErr } = await supabase
    .from("upl_payment_slips")
    .select("id")
    .or(orClauses.join(","))
    .limit(1);

  if (dupErr) return NextResponse.json({ ok: false, reason: dupErr.message }, { status: 500 });
  if (dupRows && dupRows.length > 0) {
    return NextResponse.json({ ok: false, reason: "duplicate_slip" });
  }

  // ── OCR the amount printed on the slip (never throws; ~8s internal timeout → null) ─────────
  // This is the money gate: we auto-activate ONLY when the amount OCR read is >= the plan price,
  // which closes the "฿1 unlocks Business" hole. A null/short read degrades to manual review.
  const { detected } = await ocrSlipAmount(image);

  // ── Record the slip (regardless of the gate outcome) ─────────────────────────────────────
  // We store it even when the amount can't be verified, so (a) it can never be replayed, and
  // (b) it shows in the admin console for a 1-click manual confirm. We persist the OCR amount.
  // A UNIQUE-constraint violation here (23505) means a concurrent request used the same slip
  // between our check above and this insert — treat it as the duplicate it is (race-safe).
  const { error: insErr } = await supabase.from("upl_payment_slips").insert({
    subscription_id: sub.id,
    raw_qr: decoded.rawQr,
    trans_ref: decoded.transRef,
    sending_bank: decoded.sendingBank,
    amount: detected,
    image_hash: decoded.imageHash,
    created_at: new Date().toISOString(),
  });
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: false, reason: "duplicate_slip" });
    }
    return NextResponse.json({ ok: false, reason: insErr.message }, { status: 500 });
  }

  // ── GATE: only activate when the OCR amount meets or exceeds the plan price ────────────────
  // sub.amount is the price the customer must pay (set server-side at checkout; never client-sent).
  if (detected == null || detected < sub.amount) {
    return NextResponse.json({
      ok: false,
      reason: "amount_unverified",
      needsManual: true,
      detected,
      expected: sub.amount,
    });
  }

  // ── Activate the subscription ────────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("upl_customer_subscriptions")
    .update({
      status: "active",
      activated_at: now,
      payment_verified_at: now,
      payment_channel: "web",
      cancel_at_period_end: false,
      canceled_at: null,
    })
    .eq("id", sub.id)
    .select(PUBLIC_SUB_COLUMNS)
    .maybeSingle();

  if (updErr) return NextResponse.json({ ok: false, reason: updErr.message }, { status: 500 });
  if (!updated) return NextResponse.json({ ok: false, reason: "activation_failed" }, { status: 500 });

  return NextResponse.json({
    ok: true,
    subscription: updated as unknown as SubscriptionRow,
    detectedAmount: detected,
  });
}

/**
 * PostgREST .or() uses commas as delimiters and parentheses for grouping, so a value that
 * contains them would break the filter. Slip QR strings can contain neither in practice, but
 * we defensively wrap any value that contains reserved chars in double quotes (PostgREST's
 * documented way to pass such values). Alphanumeric refs/hashes pass through untouched.
 */
function encodeOrValue(v: string): string {
  return /[(),]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}
