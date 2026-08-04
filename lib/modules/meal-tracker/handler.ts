import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage } from "../types";
import { parseMealIntent } from "./parse";
import {
  addMealEntries,
  backfillUnresolved,
  deleteLastMeal,
  findFood,
  getDayEntries,
  resolveLines,
  upsertTenantFood,
} from "./store";
import { aggregateDay, rowMacros } from "./summary";
import { sumMacros } from "./macros";
import {
  buildDayCard,
  buildEmptyRecordText,
  buildHelpText,
  buildLookupText,
  buildMealCard,
  buildTaughtText,
  buildUndoText,
  mealQuickReply,
} from "./flex";

/**
 * Meal Tracker — บันทึกอาหาร + สัดส่วนสารอาหาร (module_key: meal_tracker).
 * Per SYSTEM-DESIGN.md §4.2 (ModuleHandler interface).
 *
 * ไดอารี่แยก "รายคน" ด้วย event.source.userId — ในกลุ่ม แต่ละคนจึงมีสมุดอาหารของตัวเอง
 * โดยไม่ต้องแก้ TenantContext (ซึ่งรู้แค่ระดับแชท/กลุ่ม). ส่วน "ฐานอาหาร" ที่สอนไว้เป็นของ
 * ระดับ tenant — สอนครั้งเดียวใช้ได้ทุกกลุ่มของธุรกิจนั้น.
 *
 * คำสั่ง (parseMealIntent เป็นคนตัดสิน):
 *   - record      : "กิน [มื้อ] [วันที่]" แล้วไล่รายการทีละบรรทัด → การ์ดมื้อ + กราฟโดนัท
 *   - day_summary : "สรุปกิน [วันที่]" → การ์ดรวมทั้งวัน แยกตามมื้อ
 *   - teach       : "สอนอาหาร <ชื่อ> = C.. P.. F.. [ต่อจาน 350g]" → เก็บเข้าฐานของ tenant
 *                   แล้วย้อนเติมมาโครให้รายการที่เคยบันทึกเป็น "ยังไม่รู้จัก" ให้อัตโนมัติ
 *   - lookup      : "อาหาร <ชื่อ>" → ดูค่าสารอาหารของอาหารนั้น
 *   - undo        : "ลบกิน" → soft-delete รายการล่าสุดของคนนั้น
 *   - help        : "วิธีกิน"
 * ข้อความที่ไม่ตรงคำสั่งใด ๆ → ไม่แมตช์ (บอทเงียบ ไม่ไปแย่งข้อความของโมดูลอื่น).
 *
 * หลักความถูกต้อง: อาหารที่จับคู่กับฐานไม่ได้จะถูกบันทึกเป็น resolved=false มาโคร 0 และการ์ด
 * "ต้องขึ้นคำเตือนเสมอ" — เราไม่เดาค่าสารอาหารให้ผู้ใช้เด็ดขาด เพราะตัวเลขที่มั่วแย่กว่าตัวเลขที่ขาด.
 */

export const MealTrackerModule: ModuleHandler = {
  key: "meal_tracker",

  matchesIntent(event: LineEvent, _config: ModuleConfig): boolean {
    if (event.type !== "message" || event.message?.type !== "text") return false;
    return parseMealIntent(event.message.text ?? "", new Date()) !== null;
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const text = event.message?.text ?? "";
    const now = new Date();
    const intent = parseMealIntent(text, now);
    if (!intent) return [];

    // ใครกิน — ในกลุ่มจะได้ userId ของคนพิมพ์, ในแชท 1:1 ก็คือคู่สนทนาเอง
    const lineUserId = event.source.userId ?? null;

    switch (intent.action) {
      case "help":
        return [buildHelpText()];

      case "record": {
        if (intent.items.length === 0) return [buildEmptyRecordText()];

        const resolved = await resolveLines(ctx.tenantId, intent.items);
        await addMealEntries(
          { targetId: ctx.targetId, lineUserId, occurredOn: intent.occurredOn, slot: intent.slot },
          resolved
        );

        // โหลด "ทั้งมื้อของวันนั้น" กลับมา เพื่อให้การ์ดสะสมยอดได้เมื่อพิมพ์เพิ่มทีหลัง
        const dayRows = await getDayEntries(ctx.targetId, lineUserId, intent.occurredOn);
        const slotRows = dayRows.filter((r) => r.meal_slot === intent.slot);
        const slotTotal = sumMacros(slotRows.map(rowMacros));

        return [
          buildMealCard({
            slot: intent.slot,
            occurredOn: intent.occurredOn,
            slotInferred: !intent.slotExplicit,
            slotTotal,
            rows: slotRows,
          }),
        ];
      }

      case "day_summary": {
        const rows = await getDayEntries(ctx.targetId, lineUserId, intent.occurredOn);
        return [buildDayCard(aggregateDay(rows), intent.occurredOn)];
      }

      case "teach": {
        const food = await upsertTenantFood(ctx.tenantId, {
          name: intent.name,
          carbG: intent.carb,
          proteinG: intent.protein,
          fatG: intent.fat,
          basis: intent.basis,
          unitLabel: intent.unitLabel,
          unitGrams: intent.unitGrams,
        });

        // ย้อนเติมรายการที่เคยบันทึกไว้แต่ยังไม่รู้จักชื่อนี้ (เฉพาะแชทนี้, ย้อน 7 วัน)
        const backfilled = await backfillUnresolved(ctx.targetId, intent.name, food);

        const basisLabel =
          intent.basis === "per_100g"
            ? "ต่อ 100 กรัม"
            : `ต่อ 1 ${intent.unitLabel ?? "ที่"}${intent.unitGrams ? ` (≈ ${intent.unitGrams} g)` : ""}`;

        return [
          buildTaughtText(
            food.name,
            { carbG: intent.carb, proteinG: intent.protein, fatG: intent.fat },
            basisLabel,
            backfilled
          ),
        ];
      }

      case "lookup": {
        const food = await findFood(ctx.tenantId, intent.name);
        return [
          buildLookupText(
            intent.name,
            food
              ? {
                  name: food.name,
                  basis: food.basis,
                  unitLabel: food.unitLabel,
                  unitGrams: food.unitGrams,
                  carbG: food.carbG,
                  proteinG: food.proteinG,
                  fatG: food.fatG,
                  kcal: food.kcal,
                  source: food.source,
                }
              : null
          ),
        ];
      }

      case "undo": {
        const removed = await deleteLastMeal(ctx.targetId, lineUserId);
        if (!removed) {
          return [{ type: "text", text: "ไม่มีรายการอาหารให้ลบ", quickReply: mealQuickReply() }];
        }
        return [buildUndoText(removed)];
      }
    }
  },
};
