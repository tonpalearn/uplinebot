import { NextRequest, NextResponse } from "next/server";
import { validateMealToken } from "@/lib/meal-token";
import {
  listFoods,
  upsertTenantFood,
  deleteTenantFood,
  updateTenantFood,
  recalcEntriesForFood,
} from "@/lib/modules/meal-tracker/store";
import { estimateFoodMacros } from "@/lib/modules/meal-tracker/ai-food";
import { isGeminiEnabled } from "@/lib/ai/gemini";

/**
 * ฐานข้อมูลอาหารของหน้าเว็บ `/meal/<token>` → แท็บ "ฐานอาหาร".
 *
 *   GET    ?q=            → ลิสต์/ค้นอาหารที่ธุรกิจนี้เห็น (ของตัวเอง + ฐานกลาง)
 *   POST   {name, carbG, proteinG, fatG, ...}  → สอน/แก้เอง (source='chat')
 *   POST   {name, learn:true}                  → **สั่ง AI เรียนรู้** (source='ai-estimate')
 *   PATCH  {id, ...}      → แก้ค่าอาหารของ tenant + คำนวณไดอารี่ย้อน 7 วันใหม่ให้
 *   DELETE {id}           → ลบอาหารของ tenant (ฐานกลางลบไม่ได้)
 *
 * ขอบเขต: ฐานอาหารเป็นของ **tenant** (ทั้งธุรกิจใช้ร่วมกัน) ต่างจากไดอารี่ที่เป็นของรายคน —
 * โทเคนจึงให้สิทธิ์แก้ฐานของธุรกิจตัวเองได้ แต่ยังแตะฐานกลางที่แชร์ข้ามธุรกิจไม่ได้.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** AI ใช้เวลา 2–10 วิ ต่อคำขอ — เผื่อเวลาไว้เหมือนเส้นทาง webhook */
export const maxDuration = 30;

interface RouteCtx {
  params: { token: string };
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

/**
 * upsertTenantFood() คืน FoodRef (camelCase) แต่ GET คืนแถวดิบจาก DB (snake_case) —
 * ถ้าปล่อยไว้ ฝั่งหน้าเว็บจะได้อ็อบเจกต์คนละรูปจากสองปลายทางที่ "ควรจะเป็นของอย่างเดียวกัน"
 * แปลงให้เป็นรูปเดียวกับ GET เสมอ เพื่อให้เอาไปต่อท้ายลิสต์ได้ตรง ๆ
 */
function toRowShape(f: {
  id: string; name: string; basis: string; unitLabel: string | null; unitGrams: number | null;
  kcal: number; carbG: number; proteinG: number; fatG: number; source: string;
}, tenantId: string) {
  return {
    id: f.id,
    tenant_id: tenantId,
    name: f.name,
    aliases: null,
    basis: f.basis,
    unit_label: f.unitLabel,
    unit_grams: f.unitGrams,
    kcal: f.kcal,
    carb_g: f.carbG,
    protein_g: f.proteinG,
    fat_g: f.fatG,
    source: f.source,
  };
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  try {
    const foods = await listFoods(auth.tenantId, req.nextUrl.searchParams.get("q"));
    return NextResponse.json({ ok: true, foods, aiEnabled: isGeminiEnabled() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "read_failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ ok: false, reason: "name is required" }, { status: 400 });
  if (name.length > 60) {
    return NextResponse.json({ ok: false, reason: "name too long" }, { status: 400 });
  }

  // ── โหมด "สั่งเรียนรู้": ให้ AI ประเมินค่าให้แล้วเก็บเข้าฐานของ tenant ─────────────
  if (body.learn === true) {
    if (!isGeminiEnabled()) {
      return NextResponse.json({ ok: false, reason: "ai_disabled" }, { status: 503 });
    }
    try {
      const est = await estimateFoodMacros(name);
      // null = ไม่ผ่านด่านตรวจค่า (ไม่ใช่อาหาร / ไม่มั่นใจ / ค่าหลุดช่วง) — บอกตรง ๆ
      // ให้ผู้ใช้กรอกเองแทน ดีกว่าเก็บตัวเลขที่เราเองยังไม่เชื่อ
      if (!est) {
        return NextResponse.json({ ok: false, reason: "ai_rejected" }, { status: 422 });
      }
      const food = await upsertTenantFood(auth.tenantId, {
        name: est.name,
        carbG: est.carbG,
        proteinG: est.proteinG,
        fatG: est.fatG,
        basis: est.basis,
        unitLabel: est.unitLabel,
        unitGrams: est.unitGrams,
        aliases: est.name.trim().toLowerCase() === name.toLowerCase() ? null : name,
        source: "ai-estimate",
      });
      return NextResponse.json({ ok: true, food: toRowShape(food, auth.tenantId), confidence: est.confidence, via: "ai" });
    } catch (err) {
      return NextResponse.json(
        { ok: false, reason: err instanceof Error ? err.message : "learn_failed" },
        { status: 500 }
      );
    }
  }

  // ── โหมดกรอกเอง ────────────────────────────────────────────────────────────────
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const carbG = num(body.carbG);
  const proteinG = num(body.proteinG);
  const fatG = num(body.fatG);
  if (carbG === null || proteinG === null || fatG === null) {
    return NextResponse.json({ ok: false, reason: "carbG/proteinG/fatG must be >= 0" }, { status: 400 });
  }
  if (carbG + proteinG + fatG <= 0) {
    return NextResponse.json({ ok: false, reason: "macros must not be all zero" }, { status: 400 });
  }

  const basis = body.basis === "per_serving" ? "per_serving" : "per_100g";
  const unitLabel = typeof body.unitLabel === "string" && body.unitLabel.trim() ? body.unitLabel.trim() : null;
  const unitGramsRaw = body.unitGrams === undefined || body.unitGrams === null ? null : Number(body.unitGrams);
  const unitGrams =
    unitGramsRaw !== null && Number.isFinite(unitGramsRaw) && unitGramsRaw > 0 ? unitGramsRaw : null;

  try {
    const food = await upsertTenantFood(auth.tenantId, {
      name,
      carbG,
      proteinG,
      fatG,
      basis,
      unitLabel,
      unitGrams,
      aliases: typeof body.aliases === "string" && body.aliases.trim() ? body.aliases.trim() : null,
      source: "chat",
    });
    return NextResponse.json({ ok: true, food: toRowShape(food, auth.tenantId), via: "manual" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "save_failed" },
      { status: 500 }
    );
  }
}

/**
 * PATCH — แก้ค่าอาหารของ tenant (ที่ AI เดามาแล้วเพี้ยน หรือที่กรอกเองแล้วอยากปรับ).
 *
 * `recalc` (ค่าเริ่มต้น true): คำนวณรายการในไดอารี่ที่ใช้อาหารนี้ใหม่ ย้อน 7 วัน — เพราะผู้ใช้
 * แก้เนื่องจากค่าเดิม "ผิด" ถ้าไม่ย้อนแก้ให้ ตัวเลขวันนี้ก็ยังผิดอยู่ทั้งที่เพิ่งแก้ไปหมาด ๆ
 * ตอบกลับพร้อมจำนวนแถวที่กระทบ เพื่อให้หน้าเว็บบอกผู้ใช้ได้ว่าแก้ย้อนหลังไปกี่รายการ
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });

  const num = (v: unknown): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) {
    if (body.name.trim().length > 60) {
      return NextResponse.json({ ok: false, reason: "name too long" }, { status: 400 });
    }
    patch.name = body.name.trim();
  }
  for (const [key, field] of [["carbG", "carb_g"], ["proteinG", "protein_g"], ["fatG", "fat_g"]] as const) {
    if (body[key] !== undefined) {
      const v = num(body[key]);
      if (v === null) {
        return NextResponse.json({ ok: false, reason: `${field} must be >= 0` }, { status: 400 });
      }
      patch[key] = v;
    }
  }
  if (body.basis === "per_100g" || body.basis === "per_serving") patch.basis = body.basis;
  if (body.unitLabel !== undefined) {
    patch.unitLabel = typeof body.unitLabel === "string" && body.unitLabel.trim() ? body.unitLabel.trim() : null;
  }
  if (body.unitGrams !== undefined) patch.unitGrams = num(body.unitGrams);
  if (body.aliases !== undefined) {
    patch.aliases = typeof body.aliases === "string" && body.aliases.trim() ? body.aliases.trim() : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, reason: "nothing to update" }, { status: 400 });
  }

  try {
    const food = await updateTenantFood(auth.tenantId, id, patch);
    // ไม่เจอ = ฐานกลาง หรือของ tenant อื่น — ทั้งสองกรณีตอบเหมือนกัน ไม่บอกว่าอันไหน
    if (!food) return NextResponse.json({ ok: false, reason: "not_found_or_shared" }, { status: 404 });

    if (food.carbG + food.proteinG + food.fatG <= 0) {
      return NextResponse.json({ ok: false, reason: "macros must not be all zero" }, { status: 400 });
    }

    const recalculated =
      body.recalc === false ? 0 : await recalcEntriesForFood(auth.targetId, auth.lineUserId, food);

    return NextResponse.json({ ok: true, food: toRowShape(food, auth.tenantId), recalculated });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "update_failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });

  try {
    const removed = await deleteTenantFood(auth.tenantId, id);
    // ไม่เจอ = เป็นฐานกลาง หรือของ tenant อื่น — ทั้งสองกรณีตอบ 404 เหมือนกัน ไม่บอกว่าอันไหน
    if (!removed) return NextResponse.json({ ok: false, reason: "not_found_or_shared" }, { status: 404 });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "delete_failed" },
      { status: 500 }
    );
  }
}
