import { NextRequest, NextResponse } from "next/server";
import { validateMealToken } from "@/lib/meal-token";
import { getGoal, setGoal, clearGoal } from "@/lib/modules/meal-tracker/store";
import { goalFromGrams, goalFromPercent, goalSplit } from "@/lib/modules/meal-tracker/goal";

/**
 * เป้าหมายต่อวันของหน้าเว็บ `/meal/<token>`.
 *
 *   GET    → เป้าปัจจุบัน (null ถ้ายังไม่ตั้ง) + สัดส่วน % ที่คำนวณกลับจากกรัม
 *   PUT    {mode:"percent", kcal, carbPct, proteinPct, fatPct}  → ตั้งจากแคลอรี่ + สัดส่วน
 *          {mode:"grams", carbG, proteinG, fatG}                → ตั้งเป็นกรัมตรง ๆ
 *   DELETE → ลบเป้า
 *
 * เป้าเป็นของ **(แชท × คน)** เหมือนไดอารี่ — โทเคนพกข้อมูลนั้นมาให้แล้ว หน้าเว็บไม่ต้องส่งอะไรเพิ่ม
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: { token: string };
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

/** เพดานความสมเหตุสมผล — กันพิมพ์พลาดเป็นหลักหมื่น/หลักแสน ไม่ใช่คำแนะนำทางโภชนาการ */
const MAX_KCAL = 20000;
const MAX_MACRO_G = 2000;

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  try {
    const goal = await getGoal(auth.targetId, auth.lineUserId);
    return NextResponse.json({ ok: true, goal, split: goal ? goalSplit(goal) : null });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "read_failed" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  let goal;
  if (body.mode === "grams") {
    const c = num(body.carbG);
    const p = num(body.proteinG);
    const f = num(body.fatG);
    if (c === null || p === null || f === null) {
      return NextResponse.json({ ok: false, reason: "carbG/proteinG/fatG must be >= 0" }, { status: 400 });
    }
    if (c > MAX_MACRO_G || p > MAX_MACRO_G || f > MAX_MACRO_G) {
      return NextResponse.json({ ok: false, reason: "macro too large" }, { status: 400 });
    }
    if (c + p + f <= 0) {
      return NextResponse.json({ ok: false, reason: "goal must not be all zero" }, { status: 400 });
    }
    goal = goalFromGrams(c, p, f);
  } else {
    const kcal = num(body.kcal);
    if (kcal === null || kcal <= 0 || kcal > MAX_KCAL) {
      return NextResponse.json({ ok: false, reason: `kcal must be 1–${MAX_KCAL}` }, { status: 400 });
    }
    const cP = num(body.carbPct) ?? 50;
    const pP = num(body.proteinPct) ?? 20;
    const fP = num(body.fatPct) ?? 30;
    if (cP + pP + fP <= 0) {
      return NextResponse.json({ ok: false, reason: "percent must not be all zero" }, { status: 400 });
    }
    goal = goalFromPercent(kcal, cP, pP, fP);
  }

  if (goal.kcal <= 0 || goal.kcal > MAX_KCAL) {
    return NextResponse.json({ ok: false, reason: `kcal must be 1–${MAX_KCAL}` }, { status: 400 });
  }

  try {
    const saved = await setGoal(auth.targetId, auth.lineUserId, goal);
    return NextResponse.json({ ok: true, goal: saved, split: goalSplit(saved) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "save_failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  try {
    const had = await clearGoal(auth.targetId, auth.lineUserId);
    return NextResponse.json({ ok: true, had });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "delete_failed" },
      { status: 500 }
    );
  }
}
