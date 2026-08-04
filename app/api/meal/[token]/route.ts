import { NextRequest, NextResponse } from "next/server";
import { validateMealToken } from "@/lib/meal-token";
import {
  getDayEntries,
  getGoal,
  updateMealEntry,
  deleteMealsByIndex,
  restoreLastDelete,
  type MealEntryRow,
} from "@/lib/modules/meal-tracker/store";
import { aggregateDay } from "@/lib/modules/meal-tracker/summary";
import { computeProgress, type MealGoal } from "@/lib/modules/meal-tracker/goal";

/**
 * API ของหน้าเว็บจัดการอาหาร `/meal/<token>`.
 *
 * โทเคนคือสิทธิ์ทั้งหมด — ทุกเมธอดเรียก validateMealToken() ใหม่ฝั่งเซิร์ฟเวอร์ แล้วจำกัด
 * การอ่าน/เขียนไว้ที่ (targetId, lineUserId) ของโทเคนนั้นเท่านั้น. หน้าเว็บไม่เคยส่ง targetId
 * มาเอง และต่อให้เดา id ของแถวคนอื่นได้ ก็แก้ไม่ได้เพราะเงื่อนไขถูกยัดใน WHERE ฝั่งเซิร์ฟเวอร์.
 *
 *   GET    ?date=YYYY-MM-DD   → รายการของวันนั้น + สรุป
 *   PATCH  {id, qty?, qtyUnit?, mealSlot?, foodName?} → แก้รายการ (คำนวณมาโครใหม่)
 *   DELETE {id}               → soft delete
 *   POST   {action:"restore"} → กู้คืนการลบครั้งล่าสุด
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: { token: string };
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

/** YYYY-MM-DD ของวันนี้ตามเวลาไทย (UTC+7 คงที่ ไม่มี DST) */
function bkkTodayKey(): string {
  const bkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ใส่ความคืบหน้าเทียบเป้ามาใน payload เดียวกับรายการเลย — หน้าเว็บจะได้ไม่ต้องยิงซ้ำหลังทุก
 * การแก้/ลบ (ทุก mutation คืน payload ชุดนี้ ยอดคงเหลือจึงอัปเดตตามทันทีโดยอัตโนมัติ)
 */
function payload(rows: MealEntryRow[], occurredOn: string, goal: MealGoal | null) {
  const summary = aggregateDay(rows);
  return {
    ok: true,
    occurredOn,
    entries: rows,
    summary,
    goal,
    progress: goal ? computeProgress(goal, summary.total) : null,
  };
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  const raw = req.nextUrl.searchParams.get("date");
  const occurredOn = raw && DATE_RE.test(raw) ? raw : bkkTodayKey();

  try {
    const [rows, goal] = await Promise.all([
      getDayEntries(auth.targetId, auth.lineUserId, occurredOn),
      getGoal(auth.targetId, auth.lineUserId),
    ]);
    return NextResponse.json(payload(rows, occurredOn, goal));
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "read_failed" },
      { status: 500 }
    );
  }
}

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

  const qty = body.qty === undefined ? undefined : Number(body.qty);
  if (qty !== undefined && (!Number.isFinite(qty) || qty <= 0)) {
    return NextResponse.json({ ok: false, reason: "qty must be > 0" }, { status: 400 });
  }

  const qtyUnit = body.qtyUnit === "g" || body.qtyUnit === "unit" ? body.qtyUnit : undefined;
  const SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
  const mealSlot = SLOTS.includes(body.mealSlot as (typeof SLOTS)[number])
    ? (body.mealSlot as (typeof SLOTS)[number])
    : undefined;
  const foodName = typeof body.foodName === "string" && body.foodName.trim() ? body.foodName.trim() : undefined;

  try {
    const row = await updateMealEntry(auth.tenantId, auth.targetId, auth.lineUserId, {
      id,
      qty,
      qtyUnit,
      mealSlot,
      foodName,
    });
    if (!row) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });

    // คืนทั้งวันกลับไปด้วย เพื่อให้หน้าเว็บอัปเดตยอดรวม/สัดส่วนได้โดยไม่ต้องยิงซ้ำ
    const [rows, goal] = await Promise.all([
      getDayEntries(auth.targetId, auth.lineUserId, row.occurred_on),
      getGoal(auth.targetId, auth.lineUserId),
    ]);
    return NextResponse.json({ ...payload(rows, row.occurred_on, goal), entry: row });
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
  const occurredOn = typeof body.occurredOn === "string" && DATE_RE.test(body.occurredOn)
    ? body.occurredOn
    : bkkTodayKey();
  if (!id) return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });

  try {
    // หา "เลขลำดับของวัน" ของแถวนี้แล้วส่งให้ deleteMealsByIndex — ใช้เส้นทางลบเส้นเดียวกับ
    // ฝั่งบอท จึงได้ deleted_at เป็นชุดเดียวกัน และ "กู้กิน"/ปุ่มกู้คืนทำงานเหมือนกันทั้งสองทาง
    const rows = await getDayEntries(auth.targetId, auth.lineUserId, occurredOn);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });

    await deleteMealsByIndex(auth.targetId, auth.lineUserId, occurredOn, [idx + 1]);
    const [after, goal] = await Promise.all([
      getDayEntries(auth.targetId, auth.lineUserId, occurredOn),
      getGoal(auth.targetId, auth.lineUserId),
    ]);
    return NextResponse.json(payload(after, occurredOn, goal));
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "delete_failed" },
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

  if (body.action !== "restore") {
    return NextResponse.json({ ok: false, reason: "unknown_action" }, { status: 400 });
  }

  try {
    const restored = await restoreLastDelete(auth.targetId, auth.lineUserId);
    const occurredOn = restored[0]?.occurred_on ?? bkkTodayKey();
    const [rows, goal] = await Promise.all([
      getDayEntries(auth.targetId, auth.lineUserId, occurredOn),
      getGoal(auth.targetId, auth.lineUserId),
    ]);
    return NextResponse.json({ ...payload(rows, occurredOn, goal), restored: restored.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "restore_failed" },
      { status: 500 }
    );
  }
}
