import { NextRequest, NextResponse } from "next/server";
import { validateMealToken } from "@/lib/meal-token";
import { listFoods, importFoods, type ImportFoodInput } from "@/lib/modules/meal-tracker/store";

/**
 * สำรอง/กู้คืนฐานอาหาร ของหน้าเว็บ `/meal/<token>` → แท็บ "ฐานอาหาร".
 *
 *   GET  ?format=json|csv&shared=1  → ดาวน์โหลดไฟล์สำรอง
 *   POST {foods:[...], mode}        → กู้คืนกลับเข้าฐานของ tenant
 *
 * ทำไมต้องมี: ฐานอาหารคือของที่ผู้ใช้ลงแรงสะสม (สอนเอง + แก้ค่าที่ AI เดาผิด) ต่างจาก
 * ไดอารี่ที่พิมพ์ใหม่ได้ — ถ้าหายคือเสียเวลาที่ซื้อคืนไม่ได้ จึงต้องมีทางเอาออกมาถือไว้เอง
 *
 * ขอบเขต: อ่านได้ทั้งของ tenant และฐานกลาง (ถ้าขอ) แต่ **กู้คืนเข้าได้เฉพาะฐานของ tenant**
 * — ฐานกลางใช้ร่วมกันทุกธุรกิจ ห้ามให้ใครเขียนทับผ่านไฟล์สำรองของตัวเอง
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: { token: string };
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });
}

/** จำกัดขนาดไฟล์กู้คืน — กันยิงชุดใหญ่จนคำขอค้าง (ฐานจริงหลักร้อยรายการ) */
const MAX_IMPORT_ITEMS = 2000;

/** ครอบค่าให้ปลอดภัยสำหรับ CSV: ใส่เครื่องหมายคำพูดและหนี " ซ้อน */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const auth = await validateMealToken(ctx.params.token);
  if (!auth) return unauthorized();

  const format = req.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const includeShared = req.nextUrl.searchParams.get("shared") === "1";
  const stamp = new Date().toISOString().slice(0, 10);

  try {
    const all = await listFoods(auth.tenantId, null, 5000);
    const foods = includeShared ? all : all.filter((f) => f.tenant_id !== null);

    if (format === "csv") {
      const head = [
        "name", "carb_g", "protein_g", "fat_g", "kcal",
        "basis", "unit_label", "unit_grams", "aliases", "source", "scope",
      ];
      const lines = [
        head.join(","),
        ...foods.map((f) =>
          [
            f.name, f.carb_g, f.protein_g, f.fat_g, f.kcal,
            f.basis, f.unit_label, f.unit_grams, f.aliases, f.source,
            f.tenant_id === null ? "shared" : "mine",
          ].map(csvCell).join(",")
        ),
      ];
      // ﻿ (BOM) จำเป็นจริง — ไม่มีแล้ว Excel บน Windows เปิดภาษาไทยเป็นตัวยึกยือ
      return new NextResponse("﻿" + lines.join("\r\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="upline-foods-${stamp}.csv"`,
        },
      });
    }

    const payload = {
      kind: "upline.meal.foods",
      version: 1,
      exportedAt: new Date().toISOString(),
      count: foods.length,
      includesShared: includeShared,
      foods: foods.map((f) => ({
        name: f.name,
        carbG: Number(f.carb_g),
        proteinG: Number(f.protein_g),
        fatG: Number(f.fat_g),
        basis: f.basis,
        unitLabel: f.unit_label,
        unitGrams: f.unit_grams === null ? null : Number(f.unit_grams),
        aliases: f.aliases,
        source: f.source,
        scope: f.tenant_id === null ? "shared" : "mine",
        // kcal ไม่ได้เก็บในไฟล์เพราะคำนวณจากมาโครได้เสมอ — เก็บไว้จะกลายเป็นความจริงซ้อนที่เพี้ยนกันได้
      })),
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="upline-foods-${stamp}.json"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "export_failed" },
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

  const raw = body.foods;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ ok: false, reason: "ไฟล์ไม่มีรายการอาหาร (foods)" }, { status: 400 });
  }
  if (raw.length === 0) {
    return NextResponse.json({ ok: false, reason: "ไฟล์ไม่มีข้อมูล" }, { status: 400 });
  }
  if (raw.length > MAX_IMPORT_ITEMS) {
    return NextResponse.json(
      { ok: false, reason: `ไฟล์ใหญ่เกินไป (สูงสุด ${MAX_IMPORT_ITEMS} รายการ)` },
      { status: 400 }
    );
  }

  const mode = body.mode === "overwrite" ? "overwrite" : "skip";

  // ข้ามแถวที่เป็นฐานกลาง — กู้คืนเข้าได้เฉพาะฐานของ tenant เท่านั้น
  // รับได้ทั้งรูป camelCase (ไฟล์ JSON ของเรา) และ snake_case (คนแก้จาก CSV แล้วแปลงกลับ)
  const pick = (r: Record<string, unknown>, camel: string, snake: string): unknown =>
    r[camel] !== undefined ? r[camel] : r[snake];

  const toGrams = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const items: ImportFoodInput[] = raw
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .filter((r) => r.scope !== "shared")
    .map((r) => {
      const unitLabel = pick(r, "unitLabel", "unit_label");
      return {
        name: String(r.name ?? ""),
        carbG: Number(pick(r, "carbG", "carb_g") ?? 0),
        proteinG: Number(pick(r, "proteinG", "protein_g") ?? 0),
        fatG: Number(pick(r, "fatG", "fat_g") ?? 0),
        basis: r.basis === "per_serving" ? "per_serving" : "per_100g",
        unitLabel: typeof unitLabel === "string" && unitLabel.trim() ? unitLabel : null,
        unitGrams: toGrams(pick(r, "unitGrams", "unit_grams")),
        aliases: typeof r.aliases === "string" ? r.aliases : null,
        source: typeof r.source === "string" ? r.source : "chat",
      };
    });

  if (items.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "ไฟล์มีแต่รายการจากฐานกลาง ซึ่งกู้คืนเข้าฐานของคุณไม่ได้" },
      { status: 400 }
    );
  }

  try {
    const result = await importFoods(auth.tenantId, items, mode);
    return NextResponse.json({ ok: true, mode, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "import_failed" },
      { status: 500 }
    );
  }
}
