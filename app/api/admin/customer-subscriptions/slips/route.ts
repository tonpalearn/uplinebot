import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { adminGuard } from "@/lib/admin-auth";

// Seller-only: list the uploaded payment slips for one customer subscription, so the admin
// review page can show what the customer submitted (decoded transRef / bank / image hash) next
// to the "confirm payment" button. Kept as a separate endpoint so the existing
// /api/admin/customer-subscriptions list route (and its tests) stay untouched.
export const dynamic = "force-dynamic";

const SLIP_COLUMNS = "id, subscription_id, raw_qr, trans_ref, sending_bank, amount, slip_datetime, image_hash, created_at";

export interface PaymentSlipRow {
  id: string;
  subscription_id: string;
  raw_qr: string | null;
  trans_ref: string | null;
  sending_bank: string | null;
  amount: number | null;
  slip_datetime: string | null;
  image_hash: string;
  created_at: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });

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
    .from("upl_payment_slips")
    .select(SLIP_COLUMNS)
    .eq("subscription_id", id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, slips: (data ?? []) as unknown as PaymentSlipRow[] });
}
