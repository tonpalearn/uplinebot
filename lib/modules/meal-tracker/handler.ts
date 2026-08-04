import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage } from "../types";
import { getServiceClient } from "../../db";
import { parseMealIntent } from "./parse";
import { getOrCreateMealToken, mealManageUrl } from "../../meal-token";
import {
  addMealEntries,
  backfillUnresolved,
  deleteLastMeal,
  deleteMealsByIndex,
  deleteMealsByDay,
  restoreLastDelete,
  getGoal,
  setGoal,
  clearGoal,
  findFood,
  getDayEntries,
  resolveLines,
  upsertTenantFood,
} from "./store";
import { aggregateDay, rowMacros } from "./summary";
import { computeProgress } from "./goal";
import { sumMacros } from "./macros";
import {
  buildDayCard,
  buildEmptyRecordText,
  buildHelpText,
  buildLookupText,
  buildMealCard,
  buildTaughtText,
  buildUndoText,
  buildDayDetailCard,
  buildDeletedText,
  buildRestoredText,
  buildMealLinkText,
  buildGoalCard,
  buildGoalSetText,
  buildNoGoalText,
  buildGoalClearedText,
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

/**
 * matchesIntent() ได้ config มาแล้ว แต่ handleEvent() ได้แค่ (event, ctx) ตามสัญญา ModuleHandler
 * จึงต้องโหลดซ้ำเองด้วย ctx.targetId (แพตเทิร์นเดียวกับ knowledge-base/broadcast).
 * อ่านเฉพาะตอน "record" เท่านั้น — เส้นทางอื่นไม่ต้องแตะ DB เพิ่ม.
 */
async function loadModuleConfig(targetId: string): Promise<ModuleConfig> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_module_configs")
    .select("settings")
    .eq("target_id", targetId)
    .eq("module_key", "meal_tracker")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load meal_tracker config for target "${targetId}": ${error.message}`);
  }
  return (data?.settings as ModuleConfig) ?? {};
}

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

        // AI mode เปิดโดยค่าเริ่มต้น — ปิดต่อกลุ่มได้ด้วย config `ai_food_lookup: false`
        const config = await loadModuleConfig(ctx.targetId);
        const resolved = await resolveLines(ctx.tenantId, intent.items, {
          aiEnabled: config.ai_food_lookup !== false,
        });
        await addMealEntries(
          { targetId: ctx.targetId, lineUserId, occurredOn: intent.occurredOn, slot: intent.slot },
          resolved
        );

        // อาหารที่ AI เพิ่งเรียนรู้ในรอบนี้ → ย้อนเติมรายการเก่าที่เคยบันทึกเป็น "ยังไม่รู้จัก"
        // (ชื่อเดียวกัน แชทเดียวกัน ย้อน 7 วัน) เพื่อให้สรุปย้อนหลังไม่ขาดหายอีกต่อไป
        for (const r of resolved) {
          if (!r.viaAi || !r.food) continue;
          try {
            await backfillUnresolved(ctx.targetId, r.line.name, r.food);
          } catch (err) {
            console.warn(`[meal-ai] backfill failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        // โหลด "ทั้งมื้อของวันนั้น" กลับมา เพื่อให้การ์ดสะสมยอดได้เมื่อพิมพ์เพิ่มทีหลัง
        const dayRows = await getDayEntries(ctx.targetId, lineUserId, intent.occurredOn);
        const slotRows = dayRows.filter((r) => r.meal_slot === intent.slot);
        const slotTotal = sumMacros(slotRows.map(rowMacros));

        // โควตาที่เหลือคิดจาก "ทั้งวัน" ไม่ใช่เฉพาะมื้อนี้ — คนอยากรู้ว่าวันนี้กินได้อีกเท่าไร
        const goal = await getGoal(ctx.targetId, lineUserId);
        const dayTotal = sumMacros(dayRows.map(rowMacros));

        return [
          buildMealCard({
            slot: intent.slot,
            occurredOn: intent.occurredOn,
            slotInferred: !intent.slotExplicit,
            slotTotal,
            rows: slotRows,
            progress: goal ? computeProgress(goal, dayTotal) : null,
          }),
        ];
      }

      case "day_summary": {
        const rows = await getDayEntries(ctx.targetId, lineUserId, intent.occurredOn);
        const summary = aggregateDay(rows);
        const goal = await getGoal(ctx.targetId, lineUserId);
        return [
          buildDayCard(summary, intent.occurredOn, goal ? computeProgress(goal, summary.total) : null),
        ];
      }

      case "set_goal": {
        const goal = await setGoal(ctx.targetId, lineUserId, {
          kcal: intent.kcal,
          carbG: intent.carbG,
          proteinG: intent.proteinG,
          fatG: intent.fatG,
        });
        return [buildGoalSetText(goal)];
      }

      case "show_goal": {
        const goal = await getGoal(ctx.targetId, lineUserId);
        if (!goal) return [buildNoGoalText()];
        const rows = await getDayEntries(ctx.targetId, lineUserId, intent.occurredOn);
        const summary = aggregateDay(rows);
        return [buildGoalCard(computeProgress(goal, summary.total), intent.occurredOn, summary.count)];
      }

      case "clear_goal": {
        const had = await clearGoal(ctx.targetId, lineUserId);
        return [buildGoalClearedText(had)];
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

      case "link": {
        const token = await getOrCreateMealToken(ctx.targetId, lineUserId);
        return [buildMealLinkText(mealManageUrl(token))];
      }

      case "day_detail": {
        const rows = await getDayEntries(ctx.targetId, lineUserId, intent.occurredOn);
        // ปุ่ม "แก้ไขบนเว็บ" ต้องสร้างตอนตอบ เพราะโทเคนผูกกับ "คนที่พิมพ์" ไม่ใช่ตัวการ์ด
        const token = await getOrCreateMealToken(ctx.targetId, lineUserId);
        return [buildDayDetailCard(rows, intent.occurredOn, mealManageUrl(token))];
      }

      case "delete_items": {
        const removed = await deleteMealsByIndex(
          ctx.targetId,
          lineUserId,
          intent.occurredOn,
          intent.indexes
        );
        return [buildDeletedText(removed, intent.occurredOn)];
      }

      case "delete_day": {
        const removed = await deleteMealsByDay(
          ctx.targetId,
          lineUserId,
          intent.occurredOn,
          intent.slot ?? undefined
        );
        return [buildDeletedText(removed, intent.occurredOn)];
      }

      case "restore": {
        const restored = await restoreLastDelete(ctx.targetId, lineUserId);
        return [buildRestoredText(restored)];
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
