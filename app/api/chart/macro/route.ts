import { NextResponse } from "next/server";
import { renderDonutPng } from "../../../../lib/modules/meal-tracker/donut";
import { parseMacroParams } from "../../../../lib/modules/meal-tracker/chart-url";
import { MACRO } from "../../../../lib/modules/flex-ui";

/**
 * GET /api/chart/macro?c=<คาร์บ g>&p=<โปรตีน g>&f=<ไขมัน g>[&s=<ขนาด px>]
 *
 * คืนกราฟโดนัทสัดส่วน "พลังงาน" จากคาร์บ/โปรตีน/ไขมัน เป็น PNG โปร่งใส — LINE จะมาดึงรูปนี้เอง
 * ตอนเรนเดอร์การ์ด Flex (Flex ใส่รูปได้เฉพาะจาก URL สาธารณะ https).
 *
 * ทำไม stateless (ค่าอยู่ใน query ไม่ใช่ id ใน DB):
 *   • ไม่มีข้อมูลส่วนบุคคลเลย — มีแต่ตัวเลขกรัม 3 ตัว ใครเปิดก็เห็นแค่โดนัท ไม่รู้ว่าของใคร
 *   • URL เดิม = รูปเดิมเสมอ → แคชได้ถาวร (immutable) ทั้งที่ CDN และในแอป LINE
 *   • ไม่ต้องเขียน/อ่าน DB หรือ storage ตอนตอบแชท = การ์ดขึ้นเร็ว
 *
 * สัดส่วนคิดจากพลังงาน (Atwater 4-4-9) ไม่ใช่ "กรัม" — ตรงกับตัวเลข % บนการ์ดเป๊ะ ๆ
 * (ดู lib/modules/meal-tracker/macros.ts → macroSplit).
 */

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const params = parseMacroParams(new URL(request.url).searchParams);
  if (!params) {
    return NextResponse.json({ ok: false, reason: "invalid_params" }, { status: 400 });
  }

  const { carbG, proteinG, fatG, size } = params;

  try {
    const png = await renderDonutPng(
      [
        { value: carbG * 4, color: MACRO.carb },
        { value: proteinG * 4, color: MACRO.protein },
        { value: fatG * 9, color: MACRO.fat },
      ],
      { size }
    );

    return new Response(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        // ค่าชุดเดิมให้รูปเดิมเสมอ → แคชยาวได้อย่างปลอดภัย (LINE แคชรูปตาม URL)
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, reason: "render_failed", message }, { status: 500 });
  }
}
