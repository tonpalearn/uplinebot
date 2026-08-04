import { NextRequest, NextResponse } from "next/server";
import { validateMealToken } from "@/lib/meal-token";
import { listFoods, upsertTenantFood, deleteTenantFood } from "@/lib/modules/meal-tracker/store";
import { estimateFoodMacros } from "@/lib/modules/meal-tracker/ai-food";
import { isGeminiEnabled } from "@/lib/ai/gemini";

/**
 * ฐานข้อมูลอาหารของหน้าเว็บ `/meal/<token>` → แท็บ "ฐานอาหาร".
 *
 *   GET    ?q=            → ลิสต์/ค้นอาหารที่ธุรกิจนี้เห็น (ของตัวเอง + ฐานกลาง)
 *   POST   {name, carbG, proteinG, fatG, ...}  → สอน/แก้เอง (source='chat')
 *   POST   {name, learn:true}                  → **สั่ง AI เรียนรู้** (source='ai-estimate')
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
      return NextResponse.json({ ok: true, food, confidence: est.confidence, via: "ai" });
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
    return NextResponse.json({ ok: true, food, via: "manual" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "save_failed" },
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
