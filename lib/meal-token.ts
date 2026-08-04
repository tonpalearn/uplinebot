import { randomBytes } from "node:crypto";
import { getServiceClient } from "./db";

/**
 * โทเคนหน้าเว็บจัดการอาหาร `/meal/<token>` — แนวเดียวกับ lib/ledger-token.ts แต่ **ขอบเขตต่างกัน**.
 *
 * ledger/plan token ผูกกับ "แชท" (upl_targets) ส่วนอันนี้ผูกกับ **(แชท × คน)** ผ่านตาราง
 * upl_meal_tokens — เพราะไดอารี่อาหารเก็บแยกด้วย line_user_id อยู่แล้ว ถ้าใช้โทเคนระดับแชท
 * คนหนึ่งในกลุ่มจะเปิดดู/แก้ไดอารี่ของคนอื่นได้ ซึ่งเป็นข้อมูลสุขภาพส่วนบุคคล.
 *
 * โทเคน = ตัวยืนยันตัวตนทั้งหมดของหน้านี้ (ไม่มีล็อกอิน) ทุกคำขอที่ /api/meal/<token>
 * ต้องเรียก validateMealToken() ใหม่ฝั่งเซิร์ฟเวอร์เสมอ แล้วจำกัดสิทธิ์ให้เห็นเฉพาะ
 * (targetId, lineUserId) ของโทเคนนั้น — หน้าเว็บไม่เคยรู้จัก targetId เลย.
 */

const DEFAULT_BASE_URL = "https://uplinebot.vercel.app";

export function mealBaseUrl(): string {
  return (process.env.APP_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function mealManageUrl(token: string): string {
  return `${mealBaseUrl()}/meal/${token}`;
}

/** 24 สุ่มไบต์ → base64url 32 ตัวอักษร (ไม่มี padding, ไม่มี +/) */
function generateToken(): string {
  return randomBytes(24).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * คืนโทเคนของ (แชทนี้ × คนนี้) สร้างใหม่ถ้ายังไม่มี — idempotent ต่อคู่นั้น.
 * ใช้ upsert แข่งกันได้ปลอดภัย: ถ้าสองข้อความมาพร้อมกัน อีกฝั่งจะชน unique index แล้วเราอ่านของเดิมคืน.
 */
export async function getOrCreateMealToken(
  targetId: string,
  lineUserId: string | null
): Promise<string> {
  const supabase = getServiceClient();

  const existing = await findToken(targetId, lineUserId);
  if (existing) return existing;

  const token = generateToken();
  const { error } = await supabase
    .from("upl_meal_tokens")
    .insert({ token, target_id: targetId, line_user_id: lineUserId });

  if (error) {
    // 23505 = ชน unique index เพราะอีกคำขอสร้างไปแล้วเสี้ยววินาทีก่อน → อ่านของที่มีอยู่คืน
    if (error.code === "23505") {
      const raced = await findToken(targetId, lineUserId);
      if (raced) return raced;
    }
    throw new Error(`Failed to create meal token for target ${targetId}: ${error.message}`);
  }

  return token;
}

async function findToken(targetId: string, lineUserId: string | null): Promise<string | null> {
  const supabase = getServiceClient();
  let q = supabase.from("upl_meal_tokens").select("token").eq("target_id", targetId);
  // .eq() กับ null ใช้ไม่ได้ใน PostgREST — ต้องใช้ .is() ไม่งั้นจะไม่มีวันเจอแถวของเคส 1:1
  q = lineUserId === null ? q.is("line_user_id", null) : q.eq("line_user_id", lineUserId);

  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`Failed to read meal token for target ${targetId}: ${error.message}`);
  return (data?.token as string | undefined) ?? null;
}

export interface MealTokenAuth {
  targetId: string;
  tenantId: string;
  lineUserId: string | null;
}

/**
 * แปลงโทเคน → (targetId, tenantId, lineUserId) หรือ null ถ้าโทเคนไม่รู้จัก.
 * tenantId มาจาก target → bot (upl_targets ไม่มี tenant_id ของตัวเอง).
 */
export async function validateMealToken(token: string): Promise<MealTokenAuth | null> {
  if (!token) return null;
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("upl_meal_tokens")
    .select("target_id, line_user_id, upl_targets(upl_bots(tenant_id))")
    .eq("token", token)
    .maybeSingle();

  if (error || !data) return null;

  // supabase-js ให้ embedded to-one มาเป็น object หรือ array แล้วแต่รูปที่มันเดา — รองรับทั้งคู่
  const one = <T,>(v: unknown): T | undefined => (Array.isArray(v) ? (v[0] as T) : (v as T));
  const target = one<{ upl_bots?: unknown }>((data as { upl_targets?: unknown }).upl_targets);
  const bot = one<{ tenant_id?: string }>(target?.upl_bots);
  const tenantId = bot?.tenant_id;
  if (!tenantId) return null;

  return {
    targetId: data.target_id as string,
    tenantId,
    lineUserId: (data.line_user_id as string | null) ?? null,
  };
}
