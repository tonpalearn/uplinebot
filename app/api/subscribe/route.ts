import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getServiceClient } from "@/lib/db";
import { buildPromptPayPayload, isPromptPayConfigured } from "@/lib/payments/promptpay";
import {
  PUBLIC_SUB_COLUMNS,
  amountFor,
  fetchPlan,
  isCycle,
  isPlanKey,
  isValidEmail,
  newManageToken,
  newPaymentRef,
  periodFor,
  type SubscriptionRow,
} from "@/lib/subscriptions";

// Public self-serve subscription API. The manage_token IS the auth for reads/cancel;
// creation is open (it only writes a pending record). Never prerender.
export const dynamic = "force-dynamic";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function makeQr(amount: number) {
  const id = process.env.PROMPTPAY_ID;
  if (!isPromptPayConfigured(id)) return null;
  const payload = buildPromptPayPayload(id, amount);
  const svg = await QRCode.toString(payload, { type: "svg", margin: 1, width: 240 });
  return { payload, svg, promptpay_id: id };
}

// ── POST: create a pending subscription + PromptPay QR ──────────────────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const plan = body.plan;
  const cycle = body.cycle;
  if (!isPlanKey(plan)) return NextResponse.json({ ok: false, reason: "invalid_plan" }, { status: 400 });
  if (!isCycle(cycle)) return NextResponse.json({ ok: false, reason: "invalid_cycle" }, { status: 400 });

  const business_name = str(body.business_name);
  const customer_name = str(body.customer_name);
  const customer_email = str(body.customer_email);
  const customer_phone = str(body.customer_phone) || null;
  const line_oa_id = str(body.line_oa_id) || null;

  if (!business_name) return NextResponse.json({ ok: false, reason: "business_name is required" }, { status: 400 });
  if (!customer_name) return NextResponse.json({ ok: false, reason: "customer_name is required" }, { status: 400 });
  if (!isValidEmail(customer_email))
    return NextResponse.json({ ok: false, reason: "valid customer_email is required" }, { status: 400 });

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "server_misconfigured" },
      { status: 500 }
    );
  }

  const planRow = await fetchPlan(supabase, plan);
  if (!planRow) return NextResponse.json({ ok: false, reason: "plan_not_found" }, { status: 404 });

  const amount = amountFor(planRow, cycle);
  const period = periodFor(cycle);
  const payment_ref = newPaymentRef();
  const manage_token = newManageToken();

  const { data, error } = await supabase
    .from("upl_customer_subscriptions")
    .insert({
      plan_key: plan,
      billing_cycle: cycle,
      status: "pending",
      business_name,
      customer_name,
      customer_email,
      customer_phone,
      line_oa_id,
      amount,
      currency: "THB",
      payment_method: "promptpay",
      payment_ref,
      current_period_start: period.start,
      current_period_end: period.end,
      manage_token,
    })
    .select(PUBLIC_SUB_COLUMNS)
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, reason: error?.message ?? "insert_failed" }, { status: 500 });
  }

  let qr = null;
  try {
    qr = await makeQr(amount);
  } catch {
    qr = null; // QR is best-effort; the record still stands and the team can follow up.
  }

  return NextResponse.json({ ok: true, subscription: data as unknown as SubscriptionRow, qr });
}

// ── GET ?token=<manage_token>: fetch one subscription for the account page ───────────────
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token")?.trim();
  if (!token) return NextResponse.json({ ok: false, reason: "token is required" }, { status: 400 });

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "server_misconfigured" },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("upl_customer_subscriptions")
    .select(PUBLIC_SUB_COLUMNS)
    .eq("manage_token", token)
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });

  // Re-issue the QR for a still-pending subscription so the checkout page can resume payment.
  let qr = null;
  const sub = data as unknown as SubscriptionRow;
  if (sub.status === "pending") {
    try {
      qr = await makeQr(sub.amount);
    } catch {
      qr = null;
    }
  }

  return NextResponse.json({ ok: true, subscription: sub, qr });
}
