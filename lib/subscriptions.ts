import { randomBytes, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Shared subscription domain helpers used by the /api/subscribe routes.

export type PlanKey = "starter" | "pro" | "business";
export type Cycle = "monthly" | "yearly";

export interface PlanRow {
  plan_key: PlanKey;
  name: string;
  tagline: string | null;
  price_monthly: number;
  price_yearly: number;
}

export interface SubscriptionRow {
  id: string;
  plan_key: PlanKey;
  billing_cycle: Cycle;
  status: "pending" | "active" | "canceled" | "past_due";
  business_name: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  line_oa_id: string | null;
  amount: number;
  currency: string;
  payment_method: string;
  payment_ref: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  activated_at: string | null;
  manage_token: string;
  created_at: string;
  updated_at: string;
}

/** Columns safe to hand back to the (authenticated-by-token) customer. */
export const PUBLIC_SUB_COLUMNS =
  "id, plan_key, billing_cycle, status, business_name, customer_name, customer_email, " +
  "customer_phone, line_oa_id, amount, currency, payment_method, payment_ref, " +
  "current_period_start, current_period_end, cancel_at_period_end, canceled_at, " +
  "activated_at, manage_token, created_at, updated_at";

export function isPlanKey(v: unknown): v is PlanKey {
  return v === "starter" || v === "pro" || v === "business";
}

export function isCycle(v: unknown): v is Cycle {
  return v === "monthly" || v === "yearly";
}

export async function fetchPlan(supabase: SupabaseClient, planKey: PlanKey): Promise<PlanRow | null> {
  const { data, error } = await supabase
    .from("upl_plans")
    .select("plan_key, name, tagline, price_monthly, price_yearly")
    .eq("plan_key", planKey)
    .eq("active", true)
    .maybeSingle();
  if (error || !data) return null;
  return data as PlanRow;
}

export function amountFor(plan: PlanRow, cycle: Cycle): number {
  return cycle === "yearly" ? plan.price_yearly : plan.price_monthly;
}

/** Billing period from `from` (default now): +1 month or +1 year. */
export function periodFor(cycle: Cycle, from: Date = new Date()): { start: string; end: string } {
  const end = new Date(from);
  if (cycle === "yearly") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return { start: from.toISOString(), end: end.toISOString() };
}

/** Human-ish order reference, also used as the PromptPay memo. e.g. UPL-7F3A9C2B */
export function newPaymentRef(): string {
  return "UPL-" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** Opaque bearer token for self-serve management (no login). */
export function newManageToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
