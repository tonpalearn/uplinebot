import { getServiceClient } from "../../db";
import type { FoodBasis, MealSlot, ParsedFoodLine } from "./parse";
import { computeLineMacros, type FoodRef, type Macros } from "./macros";
import { estimateFoodMacros } from "./ai-food";
import { isGeminiEnabled } from "../../ai/gemini";

/**
 * Meal Tracker DB ops — upl_food_items (ฐานอาหาร) + upl_meal_entries (สิ่งที่กินจริง).
 *
 * ขอบเขตข้อมูล 2 ระดับ (ตั้งใจให้ต่างกัน):
 *   • ฐานอาหาร = ระดับ TENANT — ธุรกิจสอนครั้งเดียว ใช้ได้ทุกกลุ่ม/ทุกแชทของธุรกิจนั้น
 *     (แถว tenant_id = null คือฐานกลางที่ระบบ seed มาให้ ใช้ร่วมกันทุกธุรกิจ)
 *   • ไดอารี่อาหาร = ระดับ TARGET + LINE USER — "ใครกิน" ในแชทไหน แยกกันคนละเล่ม
 *     จึงใช้ในกลุ่มได้โดยที่มื้อของแต่ละคนไม่ปนกัน
 *
 * ค่ามาโครถูก snapshot ลงแถว entry ตอนบันทึก — แก้ฐานอาหารทีหลังไม่ย้อนไปแก้ประวัติ
 * (ยกเว้น backfillUnresolved ที่ตั้งใจให้ย้อนแก้เฉพาะรายการที่ยัง "ไม่รู้จัก")
 */

/** เกณฑ์ความคล้ายขั้นต่ำที่ยอมรับว่า "ใช่อาหารตัวนี้" — ต่ำกว่านี้ถือว่าไม่รู้จัก (ดีกว่าเดาผิด) */
export const FOOD_MATCH_THRESHOLD = 0.42;

/** แถวจาก meal_food_search() */
interface FoodSearchRow {
  id: string;
  tenant_id: string | null;
  name: string;
  basis: FoodBasis;
  unit_label: string | null;
  unit_grams: number | null;
  kcal: number;
  carb_g: number;
  protein_g: number;
  fat_g: number;
  source: string;
  score: number;
}

export interface MealEntryRow {
  id: string;
  target_id: string;
  line_user_id: string | null;
  occurred_on: string;
  meal_slot: MealSlot;
  food_id: string | null;
  food_name: string;
  qty: number;
  qty_unit: "g" | "unit";
  grams: number | null;
  kcal: number;
  carb_g: number;
  protein_g: number;
  fat_g: number;
  resolved: boolean;
  /** ที่มาของตัวเลข ณ เวลาบันทึก (snapshot) — 'ai-estimate' = AI เดาให้ ต้องติดป้ายบนการ์ด */
  food_source: string | null;
  raw_text: string | null;
  created_at: string;
}

const ENTRY_COLUMNS =
  "id, target_id, line_user_id, occurred_on, meal_slot, food_id, food_name, qty, qty_unit, grams, kcal, carb_g, protein_g, fat_g, resolved, food_source, raw_text, created_at";

/** แปลงแถว DB → FoodRef (รูปที่ฝั่งคำนวณใช้) — ตัวเลขจาก Postgres numeric มาเป็น string ได้ จึง Number() ทุกตัว */
function toFoodRef(row: FoodSearchRow): FoodRef {
  return {
    id: row.id,
    name: row.name,
    basis: row.basis,
    unitLabel: row.unit_label,
    unitGrams: row.unit_grams === null ? null : Number(row.unit_grams),
    kcal: Number(row.kcal),
    carbG: Number(row.carb_g),
    proteinG: Number(row.protein_g),
    fatG: Number(row.fat_g),
    source: row.source,
  };
}

/**
 * หาอาหารที่ตรงที่สุดจากชื่อที่ผู้ใช้พิมพ์ — อาหารที่ tenant สอนเองชนะฐานกลางเสมอ (ดู meal_food_search).
 * คืน null เมื่อไม่มีตัวไหนถึงเกณฑ์ → handler จะบันทึกเป็น "ยังไม่รู้จัก" แทนที่จะเดามาโครมั่ว.
 */
export async function findFood(tenantId: string, name: string): Promise<FoodRef | null> {
  const q = (name ?? "").trim();
  if (!q) return null;

  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("meal_food_search", {
    p_tenant: tenantId,
    p_name: q,
    p_limit: 3,
  });

  if (error) {
    throw new Error(`meal_food_search failed for tenant ${tenantId}: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as FoodSearchRow[];
  const best = rows[0];
  if (!best || Number(best.score) < FOOD_MATCH_THRESHOLD) return null;
  return toFoodRef(best);
}

/** ผลการจับคู่ 1 บรรทัด — เก็บทั้งที่รู้จักและไม่รู้จัก เพื่อให้การ์ดบอกผู้ใช้ได้ครบ */
export interface ResolvedLine {
  line: ParsedFoodLine;
  food: FoodRef | null;
  macros: Macros & { grams: number | null };
  /** true = อาหารตัวนี้เพิ่งถูก AI ประเมินค่าให้ในรอบนี้ (การ์ดเอาไปติดป้าย 🤖) */
  viaAi?: boolean;
}

/**
 * เพดานจำนวนอาหารที่ยอมให้ถาม AI ต่อ "หนึ่งข้อความ".
 * เหตุผล 2 ข้อ: (1) คุมค่าใช้จ่าย/กันสแปมชื่อมั่ว ๆ รัว ๆ (2) คุมเวลา — Gemini ใช้ 2–10 วิ
 * ต่อครั้ง ถึงจะยิงขนานกันก็ยังต้องรอตัวช้าสุด ต้องให้ webhook ตอบ LINE ทันเวลา.
 * ที่เกินเพดานจะตกไปเส้นทางเดิม (บันทึกเป็น "ยังไม่รู้จัก" + ขึ้นเตือน) ไม่ได้หายไปเงียบ ๆ.
 */
export const MAX_AI_LOOKUPS_PER_MESSAGE = 3;

export interface ResolveOptions {
  /** ปิดได้ต่อ target ผ่าน config `ai_food_lookup: false` (ค่าเริ่มต้น = เปิด) */
  aiEnabled?: boolean;
}

/**
 * จับคู่ทุกบรรทัดกับฐานอาหาร + คำนวณมาโคร (ยังไม่เขียนไดอารี่ แต่ **อาจเขียนฐานอาหาร**
 * ถ้า AI ประเมินตัวใหม่ได้สำเร็จ).
 *
 * ลำดับ: ฐานอาหารก่อนเสมอ → เหลือตัวที่ไม่รู้จักค่อยถาม AI (ยิงขนาน) → ตัวที่ผ่านด่านตรวจ
 * ถูกบันทึกเข้าฐาน **ของ tenant นั้น** (ไม่ใช่ฐานกลาง — AI เดาผิดจะได้ไม่ลามไปทุกธุรกิจ)
 * ครั้งต่อไปจึงเป็นการอ่าน DB ธรรมดา ไม่มีค่าใช้จ่ายซ้ำ.
 */
export async function resolveLines(
  tenantId: string,
  lines: ParsedFoodLine[],
  opts: ResolveOptions = {}
): Promise<ResolvedLine[]> {
  const out: ResolvedLine[] = [];
  const empty = { kcal: 0, carbG: 0, proteinG: 0, fatG: 0, grams: null };

  // รอบ 1 — ฐานอาหาร (เร็ว ไม่มีค่าใช้จ่าย)
  for (const line of lines) {
    const food = await findFood(tenantId, line.name);
    if (!food) {
      out.push({ line, food: null, macros: { ...empty } });
      continue;
    }
    const m = computeLineMacros(line, food);
    out.push({
      line,
      food,
      macros: { kcal: m.kcal, carbG: m.carbG, proteinG: m.proteinG, fatG: m.fatG, grams: m.grams },
    });
  }

  if (opts.aiEnabled === false || !isGeminiEnabled()) return out;

  // รอบ 2 — ตัวที่ยังไม่รู้จัก ถาม AI (ชื่อซ้ำถามครั้งเดียว)
  const missing: string[] = [];
  for (const r of out) {
    if (r.food) continue;
    const key = r.line.name.trim().toLowerCase();
    if (key && !missing.includes(key)) missing.push(key);
  }
  if (missing.length === 0) return out;

  const asked = missing.slice(0, MAX_AI_LOOKUPS_PER_MESSAGE);
  const learned = new Map<string, FoodRef>();

  await Promise.all(
    asked.map(async (key) => {
      const typed = out.find((r) => !r.food && r.line.name.trim().toLowerCase() === key)?.line.name ?? key;
      try {
        const est = await estimateFoodMacros(typed);
        if (!est) return;
        const saved = await upsertTenantFood(tenantId, {
          name: est.name,
          carbG: est.carbG,
          proteinG: est.proteinG,
          fatG: est.fatG,
          basis: est.basis,
          unitLabel: est.unitLabel,
          unitGrams: est.unitGrams,
          aliases: est.name.trim().toLowerCase() === typed.trim().toLowerCase() ? null : typed,
          source: "ai-estimate",
        });
        learned.set(key, saved);
      } catch (err) {
        // AI/DB ล้ม = ตกกลับไปเส้นทาง "ยังไม่รู้จัก" ตามเดิม ห้ามทำให้ทั้งข้อความพัง
        console.warn(`[meal-ai] learn failed for "${typed}": ${err instanceof Error ? err.message : err}`);
      }
    })
  );

  if (learned.size === 0) return out;

  // รอบ 3 — คำนวณมาโครให้บรรทัดที่เพิ่งได้อาหารใหม่
  for (const r of out) {
    if (r.food) continue;
    const food = learned.get(r.line.name.trim().toLowerCase());
    if (!food) continue;
    const m = computeLineMacros(r.line, food);
    r.food = food;
    r.viaAi = true;
    r.macros = { kcal: m.kcal, carbG: m.carbG, proteinG: m.proteinG, fatG: m.fatG, grams: m.grams };
  }

  return out;
}

export interface AddMealContext {
  targetId: string;
  lineUserId: string | null;
  occurredOn: string;
  slot: MealSlot;
}

/** บันทึกรายการที่จับคู่แล้วลงไดอารี่ */
export async function addMealEntries(ctx: AddMealContext, resolved: ResolvedLine[]): Promise<MealEntryRow[]> {
  if (resolved.length === 0) return [];

  const payload = resolved.map((r) => ({
    target_id: ctx.targetId,
    line_user_id: ctx.lineUserId,
    occurred_on: ctx.occurredOn,
    meal_slot: ctx.slot,
    food_id: r.food?.id ?? null,
    food_name: r.food?.name ?? r.line.name,
    qty: r.line.qty,
    qty_unit: r.line.unit,
    grams: r.macros.grams,
    kcal: r.macros.kcal,
    carb_g: r.macros.carbG,
    protein_g: r.macros.proteinG,
    fat_g: r.macros.fatG,
    resolved: r.food !== null,
    food_source: r.food?.source ?? null,
    raw_text: r.line.raw,
  }));

  const supabase = getServiceClient();
  const { data, error } = await supabase.from("upl_meal_entries").insert(payload).select(ENTRY_COLUMNS);

  if (error) {
    throw new Error(`Failed to insert meal entries for target ${ctx.targetId}: ${error.message}`);
  }
  return (data ?? []) as unknown as MealEntryRow[];
}

/**
 * รายการทั้งหมดของ "หนึ่งวัน หนึ่งคน" (เรียงตามเวลาบันทึก).
 * lineUserId = null → ดูรวมทั้งแชท (ใช้ในแชท 1:1 ที่ยังไม่มี userId ด้วยเหตุผลใดก็ตาม)
 */
export async function getDayEntries(
  targetId: string,
  lineUserId: string | null,
  occurredOn: string
): Promise<MealEntryRow[]> {
  const supabase = getServiceClient();
  let query = supabase
    .from("upl_meal_entries")
    .select(ENTRY_COLUMNS)
    .eq("target_id", targetId)
    .eq("occurred_on", occurredOn)
    .is("deleted_at", null);

  if (lineUserId) query = query.eq("line_user_id", lineUserId);

  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Failed to load meal entries for target ${targetId}: ${error.message}`);
  }
  return (data ?? []) as unknown as MealEntryRow[];
}

/** soft-delete รายการล่าสุดของคนนั้นในแชทนั้น — คืนแถวที่ลบ หรือ null ถ้าไม่มี */
export async function deleteLastMeal(targetId: string, lineUserId: string | null): Promise<MealEntryRow | null> {
  const supabase = getServiceClient();
  let query = supabase
    .from("upl_meal_entries")
    .select(ENTRY_COLUMNS)
    .eq("target_id", targetId)
    .is("deleted_at", null);

  if (lineUserId) query = query.eq("line_user_id", lineUserId);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
  if (error) {
    throw new Error(`Failed to find last meal entry for target ${targetId}: ${error.message}`);
  }

  const row = (data ?? [])[0] as unknown as MealEntryRow | undefined;
  if (!row) return null;

  const { error: delError } = await supabase
    .from("upl_meal_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", row.id);

  if (delError) {
    throw new Error(`Failed to delete meal entry ${row.id}: ${delError.message}`);
  }
  return row;
}

export interface TeachFoodInput {
  name: string;
  carbG: number;
  proteinG: number;
  fatG: number;
  basis: FoodBasis;
  unitLabel: string | null;
  unitGrams: number | null;
  /** คำเรียกอื่นที่ควรจับคู่ได้ด้วย (เช่นชื่อที่ผู้ใช้พิมพ์จริง ก่อน AI ปรับเป็นชื่อมาตรฐาน) */
  aliases?: string | null;
  /** ที่มาของตัวเลข — 'chat' = คนสอนเอง (ค่าเริ่มต้น) · 'ai-estimate' = AI ประเมินให้ */
  source?: "chat" | "ai-estimate" | "admin";
}

/**
 * สอน/แก้อาหารของ tenant — upsert ตามชื่อ (ทับของเดิมที่ tenant เคยสอนไว้).
 * kcal คำนวณจากมาโครด้วย Atwater เสมอ เพื่อไม่ให้ "พลังงาน" กับ "สัดส่วน %" ขัดกันบนการ์ด.
 *
 * หมายเหตุ: คนสอนเอง ('chat') **ทับ** ค่าที่ AI เคยเดาไว้ได้เสมอ เพราะเป็น upsert ตามชื่อเดียวกัน
 * — เจ้าของธุรกิจจึงแก้เลขที่ AI เดาผิดได้ทันทีด้วย "สอนอาหาร".
 */
export async function upsertTenantFood(tenantId: string, input: TeachFoodInput): Promise<FoodRef> {
  const supabase = getServiceClient();
  const name = input.name.trim();
  const kcal = Math.round(input.carbG * 4 + input.proteinG * 4 + input.fatG * 9);

  const payload = {
    tenant_id: tenantId,
    name,
    aliases: input.aliases?.trim() || null,
    basis: input.basis,
    unit_label: input.unitLabel,
    unit_grams: input.unitGrams,
    carb_g: input.carbG,
    protein_g: input.proteinG,
    fat_g: input.fatG,
    kcal,
    source: input.source ?? "chat",
    updated_at: new Date().toISOString(),
  };

  // ไม่มี unique constraint ตรง ๆ ให้ onConflict ใช้ได้ (เป็น partial unique index บน lower(name))
  // จึงทำ select-then-insert/update เอง
  const { data: existing, error: findError } = await supabase
    .from("upl_food_items")
    .select("id")
    .eq("tenant_id", tenantId)
    .ilike("name", name)
    .maybeSingle();

  if (findError) {
    throw new Error(`Failed to look up tenant food "${name}": ${findError.message}`);
  }

  const columns = "id, name, basis, unit_label, unit_grams, kcal, carb_g, protein_g, fat_g, source";
  const { data, error } = existing?.id
    ? await supabase.from("upl_food_items").update(payload).eq("id", existing.id).select(columns).single()
    : await supabase.from("upl_food_items").insert(payload).select(columns).single();

  if (error) {
    throw new Error(`Failed to save tenant food "${name}": ${error.message}`);
  }

  const row = data as unknown as Omit<FoodSearchRow, "tenant_id" | "score">;
  return toFoodRef({ ...row, tenant_id: tenantId, score: 1 } as FoodSearchRow);
}

/**
 * หลังผู้ใช้ "สอนอาหาร" — ย้อนไปเติมมาโครให้รายการที่เคยบันทึกเป็น "ยังไม่รู้จัก" ด้วยชื่อเดียวกัน
 * (เฉพาะแชทนี้ และย้อนไม่เกิน `sinceDays` วัน เพื่อไม่ให้แก้ประวัติเก่าเกินไปโดยไม่ตั้งใจ).
 * คืนจำนวนรายการที่อัปเดต — handler เอาไปบอกผู้ใช้ว่า "อัปเดตย้อนหลัง N รายการแล้ว".
 */
export async function backfillUnresolved(
  targetId: string,
  typedName: string,
  food: FoodRef,
  sinceDays = 7
): Promise<number> {
  const supabase = getServiceClient();
  const name = typedName.trim();
  if (!name) return 0;

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("upl_meal_entries")
    .select(ENTRY_COLUMNS)
    .eq("target_id", targetId)
    .eq("resolved", false)
    .is("deleted_at", null)
    .gte("occurred_on", since)
    .ilike("food_name", name);

  if (error) {
    throw new Error(`Failed to find unresolved meal entries for "${name}": ${error.message}`);
  }

  const rows = (data ?? []) as unknown as MealEntryRow[];
  let updated = 0;

  for (const row of rows) {
    const line: ParsedFoodLine = {
      name: row.food_name,
      qty: Number(row.qty),
      unit: row.qty_unit,
      unitLabel: null,
      raw: row.raw_text ?? row.food_name,
    };
    const m = computeLineMacros(line, food);

    const { error: upError } = await supabase
      .from("upl_meal_entries")
      .update({
        food_id: food.id,
        food_name: food.name,
        grams: m.grams,
        kcal: m.kcal,
        carb_g: m.carbG,
        protein_g: m.proteinG,
        fat_g: m.fatG,
        resolved: true,
        food_source: food.source,
      })
      .eq("id", row.id);

    if (upError) {
      throw new Error(`Failed to backfill meal entry ${row.id}: ${upError.message}`);
    }
    updated += 1;
  }

  return updated;
}
