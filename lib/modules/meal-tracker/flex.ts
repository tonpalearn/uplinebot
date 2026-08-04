import type { OutboundMessage, QuickReplyItem } from "../types";
import {
  FS,
  NEUTRAL,
  MACRO,
  MEAL_ACCENT,
  gradientHeader,
  headerStyle,
  footerStyle,
  numberChip,
  softSep,
  messageButton,
  colorDot,
} from "../flex-ui";
import { SLOT_EMOJI, SLOT_LABEL, type MealSlot } from "./parse";
import { macroSplit, type MacroSplit, type Macros } from "./macros";
import { formatThaiDate, rowMacros, type DaySummary } from "./summary";
import type { MealEntryRow } from "./store";
import { macroChartUrl } from "./chart-url";

/**
 * Flex builders ของโมดูลบันทึกอาหาร — สวมชุดดีไซน์กลาง (lib/modules/flex-ui.ts) ในโทน MEAL
 * (หัวการ์ดไล่สีส้ม) ให้แยกออกจากการ์ดงาน (แดง) และการ์ดเงิน (เขียว) ได้ตั้งแต่ชายตามอง.
 *
 * กราฟโดนัทเป็น "รูป PNG จาก /api/chart/macro" ไม่ใช่กล่อง Flex — เพราะ Flex วาดวงกลม/ส่วนโค้ง
 * ไม่ได้เลย (มีแต่กล่องสี่เหลี่ยมกับ cornerRadius) ส่วนตัวหนังสือทั้งหมดอยู่บนการ์ด ไม่ได้อยู่ในรูป
 * จึงคมชัดตามฟอนต์เครื่องผู้ใช้เสมอ และไม่ต้องมีฟอนต์ไทยบนเซิร์ฟเวอร์.
 *
 * ทุกตัวเลข % มาจาก macroSplit() (พลังงานแบบ Atwater) — ตัวเดียวกับที่ส่งให้กราฟ จึงตรงกันเสมอ.
 */

/** จำนวนรายการสูงสุดที่ลิสต์บนการ์ด (เกินกว่านี้สรุปเป็น "และอีก N รายการ") */
const MAX_ITEM_ROWS = 8;

// ── ฟอร์แมตตัวเลข ────────────────────────────────────────────────────────────────
/** 1842 → "1,842" */
function formatKcal(n: number): string {
  return Math.round(n).toLocaleString("th-TH");
}

/** 72.44 → "72.4" · 19 → "19" (ตัด .0 ทิ้งให้อ่านง่าย) */
export function formatGrams(n: number): string {
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** ดึงคำหน่วยจากข้อความเดิมถ้ามี (เช่น "ไข่ต้ม 2 ฟอง" → "ฟอง") — ไม่มีก็ใช้ "ที่" */
function unitLabelFrom(row: MealEntryRow): string {
  const m = (row.raw_text ?? "").match(/\d+(?:\.\d+)?\s*([ก-๙]+)\s*$/);
  return m ? m[1] : "ที่";
}

/** "2 ฟอง" · "150 g" · "1 ที่" — ปริมาณที่ผู้ใช้พิมพ์ ในรูปที่อ่านกลับได้ */
function formatQty(row: MealEntryRow): string {
  const n = formatGrams(Number(row.qty));
  return row.qty_unit === "g" ? `${n} g` : `${n} ${unitLabelFrom(row)}`;
}

// ── Quick Reply ──────────────────────────────────────────────────────────────────
export function mealQuickReply(): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "📊 สรุปวันนี้", text: "สรุปกิน" } },
      { type: "action", action: { type: "message", label: "🍽️ รายละเอียด", text: "รายละเอียดกิน" } },
      { type: "action", action: { type: "message", label: "🌅 เช้า", text: "กิน เช้า " } },
      { type: "action", action: { type: "message", label: "☀️ กลางวัน", text: "กิน กลางวัน " } },
      { type: "action", action: { type: "message", label: "🌙 เย็น", text: "กิน เย็น " } },
      { type: "action", action: { type: "message", label: "↩️ ลบล่าสุด", text: "ลบกิน" } },
      { type: "action", action: { type: "message", label: "✏️ จัดการ", text: "จัดการอาหาร" } },
    ],
  };
}

// ── ชิ้นส่วนที่ใช้ร่วมกัน ─────────────────────────────────────────────────────────
/** รูปกราฟโดนัท (กึ่งกลาง) — ขนาด xxl ≈ 160px กำลังพอดีกับความกว้างการ์ด LINE */
function donutImage(m: Macros): Record<string, unknown> {
  return {
    type: "image",
    url: macroChartUrl(m.carbG, m.proteinG, m.fatG),
    size: "xxl",
    aspectRatio: "1:1",
    aspectMode: "fit",
    align: "center",
    margin: "sm",
  };
}

/** หนึ่งแถวคำอธิบายสี: จุดสี + ชื่อสารอาหาร + กรัม + % */
function legendRow(color: string, label: string, grams: number, pct: number): Record<string, unknown> {
  return {
    type: "box",
    layout: "horizontal",
    margin: "md",
    spacing: "sm",
    alignItems: "center",
    contents: [
      colorDot(color),
      { type: "text", text: label, size: FS.label, color: NEUTRAL.text, flex: 3 },
      {
        type: "text",
        text: `${formatGrams(grams)} g`,
        size: FS.label,
        color: NEUTRAL.text,
        weight: "bold",
        align: "end",
        flex: 3,
      },
      {
        type: "text",
        text: `${pct}%`,
        size: FS.meta,
        color: NEUTRAL.muted,
        align: "end",
        flex: 2,
      },
    ],
  };
}

/** คำอธิบายสีครบ 3 สารอาหาร */
function legend(m: Macros, split: MacroSplit): Record<string, unknown>[] {
  return [
    legendRow(MACRO.carb, "คาร์บ", m.carbG, split.carbPct),
    legendRow(MACRO.protein, "โปรตีน", m.proteinG, split.proteinPct),
    legendRow(MACRO.fat, "ไขมัน", m.fatG, split.fatPct),
  ];
}

/** แถบสัดส่วนแนวนอนแบบ 3 สีต่อกัน (ใช้ในแถว "แยกตามมื้อ" ที่ไม่มีที่พอสำหรับโดนัท) */
function stackedBar(split: MacroSplit): Record<string, unknown> {
  const seg = (pct: number, color: string) =>
    pct <= 0
      ? null
      : {
          type: "box",
          layout: "vertical",
          width: `${pct}%`,
          height: "8px",
          backgroundColor: color,
          contents: [{ type: "filler" }],
        };

  const parts = [
    seg(split.carbPct, MACRO.carb),
    seg(split.proteinPct, MACRO.protein),
    seg(split.fatPct, MACRO.fat),
  ].filter(Boolean) as Record<string, unknown>[];

  return {
    type: "box",
    layout: "horizontal",
    height: "8px",
    cornerRadius: "4px",
    backgroundColor: NEUTRAL.track,
    margin: "sm",
    contents: parts.length > 0 ? parts : [{ type: "filler" }],
  };
}

/** ชื่ออาหารในชุดนี้ที่ตัวเลข "มาจาก AI ประเมิน" (ไม่ซ้ำ) */
export function aiEstimatedNames(rows: MealEntryRow[]): string[] {
  return Array.from(new Set(rows.filter((r) => r.food_source === "ai-estimate").map((r) => r.food_name)));
}

/**
 * บรรทัดบอกที่มาเมื่อมีตัวเลขจาก AI — **ต้องขึ้นเสมอ** เมื่อเกิดขึ้น.
 * เหตุผล: บนการ์ด ผู้ใช้แยกไม่ออกเลยว่าเลขไหนมาจากฐานที่คนตรวจแล้ว เลขไหน AI เดาให้ —
 * ถ้าไม่ติดป้าย เท่ากับยกระดับ "ค่าประมาณของ AI" ขึ้นเป็น "ข้อเท็จจริง" โดยไม่ได้ตั้งใจ.
 */
function aiNotice(names: string[]): Record<string, unknown>[] {
  if (names.length === 0) return [];
  return [
    {
      type: "text",
      text: `🤖 ${names.join(", ")} — ไม่มีในฐาน AI ประเมินค่าให้และจำไว้แล้ว (เป็นค่าประมาณ) แก้ได้ด้วย\nสอนอาหาร ${names[0]} = C.. P.. F..`,
      size: FS.meta,
      color: "#1D4ED8",
      wrap: true,
      margin: "lg",
    },
  ];
}

/** บรรทัดเตือนอาหารที่ยังไม่รู้จัก — ต้องมีเสมอเมื่อเกิดขึ้น ไม่งั้นยอดรวมจะต่ำกว่าจริงแบบเงียบ ๆ */
function unknownNotice(names: string[]): Record<string, unknown>[] {
  if (names.length === 0) return [];
  return [
    softSep("lg"),
    {
      type: "text",
      text: `⚠️ ยังไม่รู้จัก: ${names.join(", ")}\nยอดรวมยังไม่นับรายการนี้ — สอนได้เลย เช่น\nสอนอาหาร ${names[0]} = C30 P10 F5`,
      size: FS.meta,
      color: "#B45309",
      wrap: true,
      margin: "lg",
    },
  ];
}

// ── การ์ดมื้ออาหาร (ตอบหลังบันทึก) ────────────────────────────────────────────────
export interface MealCardOpts {
  slot: MealSlot;
  occurredOn: string;
  /** true = ระบบเดามื้อให้จากเวลา (ผู้ใช้ไม่ได้พิมพ์มื้อมา) */
  slotInferred: boolean;
  /** ยอดรวมของ "ทั้งมื้อนั้นในวันนั้น" (ไม่ใช่แค่ที่เพิ่งพิมพ์) */
  slotTotal: Macros;
  rows: MealEntryRow[];
}

/**
 * การ์ดสรุปหนึ่งมื้อ: หัวส้ม (มื้อ + วันที่ + พลังงาน), โดนัทสัดส่วน, คำอธิบายสี C/P/F,
 * รายการที่กิน, และคำเตือนของที่ยังไม่รู้จัก.
 */
export function buildMealCard(opts: MealCardOpts): OutboundMessage {
  const { slot, slotTotal, rows } = opts;
  const split = macroSplit(slotTotal);

  const shown = rows.slice(0, MAX_ITEM_ROWS);
  const itemRows: Record<string, unknown>[] = shown.map((row, i) => {
    const m = rowMacros(row);
    return {
      type: "box",
      layout: "horizontal",
      margin: "md",
      spacing: "md",
      contents: [
        numberChip(i + 1, MEAL_ACCENT, !row.resolved),
        {
          type: "box",
          layout: "vertical",
          flex: 1,
          justifyContent: "center",
          spacing: "none",
          contents: [
            {
              type: "text",
              text: row.food_source === "ai-estimate" ? `🤖 ${row.food_name}` : row.food_name,
              size: FS.body,
              color: row.resolved ? NEUTRAL.text : NEUTRAL.muted,
              weight: "bold",
              wrap: true,
            },
            {
              type: "text",
              text: row.resolved
                ? `${formatQty(row)} · C ${formatGrams(Number(row.carb_g))} · P ${formatGrams(
                    Number(row.protein_g)
                  )} · F ${formatGrams(Number(row.fat_g))}`
                : `${formatQty(row)} · ยังไม่รู้จัก`,
              size: FS.meta,
              color: NEUTRAL.muted,
              margin: "xs",
              wrap: true,
            },
          ],
        },
        {
          type: "text",
          text: row.resolved ? `${formatKcal(m.kcal)}` : "—",
          size: FS.body,
          color: row.resolved ? MEAL_ACCENT.solid : NEUTRAL.muted,
          weight: "bold",
          align: "end",
          gravity: "center",
          flex: 0,
        },
      ],
    };
  });

  if (rows.length > shown.length) {
    itemRows.push({
      type: "text",
      text: `และอีก ${rows.length - shown.length} รายการ`,
      size: FS.meta,
      color: NEUTRAL.muted,
      margin: "md",
      align: "center",
    });
  }

  const unresolvedNames = Array.from(
    new Set(rows.filter((r) => !r.resolved).map((r) => r.food_name))
  );

  const bodyContents: Record<string, unknown>[] = [
    donutImage(slotTotal),
    ...legend(slotTotal, split),
    softSep("lg"),
    {
      type: "text",
      text: "รายการที่กิน",
      size: FS.section,
      weight: "bold",
      color: NEUTRAL.text,
      margin: "lg",
    },
    ...itemRows,
    ...aiNotice(aiEstimatedNames(rows)),
    ...unknownNotice(unresolvedNames),
  ];

  const eyebrow = `${SLOT_EMOJI[slot]} ${SLOT_LABEL[slot]}${
    opts.slotInferred ? " (เดาจากเวลา)" : ""
  } · ${formatThaiDate(opts.occurredOn)}`;

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: MEAL_ACCENT,
      eyebrow,
      heroLabel: "พลังงานมื้อนี้",
      hero: `${formatKcal(slotTotal.kcal)} kcal`,
      subtitle: `C ${split.carbPct}% · P ${split.proteinPct}% · F ${split.fatPct}%`,
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "12px",
      spacing: "none",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "sm",
      contents: [messageButton("📊 สรุปทั้งวัน", "สรุปกิน", MEAL_ACCENT.solid)],
    },
    styles: { header: headerStyle(MEAL_ACCENT), footer: footerStyle() },
  };

  const altText = `${SLOT_LABEL[slot]} ${formatThaiDate(opts.occurredOn)} — ${formatKcal(
    slotTotal.kcal
  )} kcal · C ${formatGrams(slotTotal.carbG)}g P ${formatGrams(slotTotal.proteinG)}g F ${formatGrams(
    slotTotal.fatG
  )}g`;

  return { type: "flex", altText, contents: bubble, quickReply: mealQuickReply() };
}

// ── การ์ดสรุปทั้งวัน ──────────────────────────────────────────────────────────────
/** หนึ่งแถวของ "แยกตามมื้อ": อีโมจิ+ชื่อมื้อ + kcal แล้วแถบสัดส่วน C:P:F ใต้บรรทัด */
function slotRow(
  slot: MealSlot,
  macros: Macros,
  split: MacroSplit,
  count: number
): Record<string, unknown> {
  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    spacing: "none",
    contents: [
      {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "text",
            text: `${SLOT_EMOJI[slot]} ${SLOT_LABEL[slot]}`,
            size: FS.label,
            color: NEUTRAL.text,
            weight: "bold",
            flex: 1,
          },
          {
            type: "text",
            text: `${formatKcal(macros.kcal)} kcal`,
            size: FS.label,
            color: MEAL_ACCENT.solid,
            weight: "bold",
            align: "end",
            flex: 0,
          },
        ],
      },
      {
        type: "text",
        text: `C ${formatGrams(macros.carbG)}g · P ${formatGrams(macros.proteinG)}g · F ${formatGrams(
          macros.fatG
        )}g  (${split.carbPct}:${split.proteinPct}:${split.fatPct})  · ${count} รายการ`,
        size: FS.caption,
        color: NEUTRAL.muted,
        margin: "xs",
        wrap: true,
      },
      stackedBar(split),
    ],
  };
}

/**
 * การ์ดสรุปทั้งวัน: หัวส้ม (พลังงานรวม + สัดส่วน), โดนัทรวม, คำอธิบายสี, แล้วแยกตามมื้อ
 * พร้อมแถบสัดส่วนของแต่ละมื้อ. วันที่ไม่มีข้อมูล → คืนข้อความชวนบันทึกแทนการ์ดเปล่า.
 */
export function buildDayCard(summary: DaySummary, occurredOn: string): OutboundMessage {
  if (summary.count === 0) {
    return {
      type: "text",
      text: `ยังไม่มีบันทึกอาหารของ ${formatThaiDate(occurredOn)}\n\nพิมพ์แบบนี้ได้เลย:\nกิน เช้า\nข้าวสวย 100g\nไข่ต้ม 2 ฟอง`,
      quickReply: mealQuickReply(),
    };
  }

  const bodyContents: Record<string, unknown>[] = [
    donutImage(summary.total),
    ...legend(summary.total, summary.split),
    softSep("lg"),
    {
      type: "text",
      text: "แยกตามมื้อ",
      size: FS.section,
      weight: "bold",
      color: NEUTRAL.text,
      margin: "lg",
    },
    ...summary.bySlot.map((s) => slotRow(s.slot, s.macros, s.split, s.count)),
    ...aiNotice(summary.aiNames),
    ...unknownNotice(summary.unresolvedNames),
  ];

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: MEAL_ACCENT,
      eyebrow: `📊 สรุปทั้งวัน · ${formatThaiDate(occurredOn)}`,
      heroLabel: "พลังงานรวม",
      hero: `${formatKcal(summary.total.kcal)} kcal`,
      subtitle: `C ${summary.split.carbPct}% · P ${summary.split.proteinPct}% · F ${summary.split.fatPct}%  ·  ${summary.count} รายการ`,
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "12px",
      spacing: "none",
      contents: bodyContents,
    },
    styles: { header: headerStyle(MEAL_ACCENT) },
  };

  const altText = `สรุปอาหาร ${formatThaiDate(occurredOn)} — ${formatKcal(
    summary.total.kcal
  )} kcal · C ${summary.split.carbPct}% P ${summary.split.proteinPct}% F ${summary.split.fatPct}%`;

  return { type: "flex", altText, contents: bubble, quickReply: mealQuickReply() };
}

// ── ข้อความสั้น ๆ (ไม่ต้องใช้การ์ด) ────────────────────────────────────────────────
/** ยืนยันหลังสอนอาหารใหม่ */
export function buildTaughtText(
  name: string,
  macros: { carbG: number; proteinG: number; fatG: number },
  basisLabel: string,
  backfilled: number
): OutboundMessage {
  const kcal = Math.round(macros.carbG * 4 + macros.proteinG * 4 + macros.fatG * 9);
  const back = backfilled > 0 ? `\n↩️ อัปเดตรายการที่เคยบันทึกไว้ย้อนหลังให้แล้ว ${backfilled} รายการ` : "";
  return {
    type: "text",
    text: `✅ จำแล้ว: ${name}\n${basisLabel} — C ${formatGrams(macros.carbG)}g · P ${formatGrams(
      macros.proteinG
    )}g · F ${formatGrams(macros.fatG)}g ≈ ${kcal} kcal${back}`,
    quickReply: mealQuickReply(),
  };
}

/** ผลการค้นค่าอาหารหนึ่งอย่าง */
export function buildLookupText(
  name: string,
  found: { name: string; basis: string; unitLabel: string | null; unitGrams: number | null; carbG: number; proteinG: number; fatG: number; kcal: number; source: string } | null
): OutboundMessage {
  if (!found) {
    return {
      type: "text",
      text: `ยังไม่มี "${name}" ในคลังอาหาร\n\nสอนได้เลย เช่น\nสอนอาหาร ${name} = C30 P10 F5 ต่อจาน`,
      quickReply: mealQuickReply(),
    };
  }

  const per =
    found.basis === "per_100g"
      ? "ต่อ 100 กรัม"
      : `ต่อ 1 ${found.unitLabel ?? "ที่"}${found.unitGrams ? ` (≈ ${formatGrams(found.unitGrams)} g)` : ""}`;
  const split = macroSplit({ kcal: found.kcal, carbG: found.carbG, proteinG: found.proteinG, fatG: found.fatG });
  const origin = found.source === "chat" ? "ที่คุณสอนไว้" : "ค่าประมาณจากฐานกลาง";

  return {
    type: "text",
    text: `🍽️ ${found.name} (${per})\nC ${formatGrams(found.carbG)}g · P ${formatGrams(
      found.proteinG
    )}g · F ${formatGrams(found.fatG)}g\n≈ ${formatKcal(found.kcal)} kcal — สัดส่วนพลังงาน ${split.carbPct}:${
      split.proteinPct
    }:${split.fatPct}\n(${origin})`,
    quickReply: mealQuickReply(),
  };
}

/** วิธีใช้ */
export function buildHelpText(): OutboundMessage {
  return {
    type: "text",
    text: [
      "🍽️ บันทึกอาหาร — พิมพ์แบบนี้",
      "",
      "กิน เช้า 3 ส.ค.",
      "ข้าวสวย 100g",
      "ไข่ต้ม 2 ฟอง",
      "อกไก่ 150g",
      "",
      "• ไม่ใส่มื้อ/วันที่ = ใช้ของวันนี้และเดามื้อจากเวลา",
      "• ระบุวันได้ทั้งย้อนหลังและล่วงหน้า: พรุ่งนี้ · มะรืน · เมื่อวาน · 3/7 · 3 ส.ค. · อีก 2 วัน",
      "• ปริมาณพิมพ์ได้ทั้ง 100g · 2 ขีด · 1 ทัพพี · 2 ฟอง · ครึ่งจาน",
      "• สรุปกิน = สรุปทั้งวัน (ใส่วันที่ต่อท้ายเพื่อดูย้อนหลัง)",
      "• รายละเอียดกิน = ดูว่าแต่ละมื้อกินอะไรไปบ้าง",
      "• สอนอาหาร ข้าวมันไก่ = C78 P28 F22 ต่อจาน",
      "• อาหาร ข้าวสวย = ดูค่าสารอาหาร",
      "",
      "ลบรายการ:",
      "• ลบกิน = ลบรายการล่าสุด",
      "• ลบกิน 3 = ลบรายการที่ 3 (เลขจากรายละเอียดกิน)",
      "• ลบกิน เช้า = ลบทั้งมื้อเช้า",
      "• ลบกินทั้งวัน = ลบทุกรายการของวันนี้",
      "• กู้กิน = เอาที่เพิ่งลบกลับคืน (ภายใน 24 ชม.)",
    ].join("\n"),
    quickReply: mealQuickReply(),
  };
}

/** ตอบเมื่อพิมพ์ "กิน" เปล่า ๆ หรืออ่านรายการไม่ออกเลย */
export function buildEmptyRecordText(): OutboundMessage {
  return {
    type: "text",
    text: 'พิมพ์ "กิน" แล้วตามด้วยมื้อ + รายการทีละบรรทัด เช่น\n\nกิน เช้า\nข้าวสวย 100g\nไข่ต้ม 2 ฟอง',
    quickReply: mealQuickReply(),
  };
}

/** ยืนยันการลบรายการล่าสุด */
// ── การ์ดรายละเอียดรายมื้อ ───────────────────────────────────────────────────────
/**
 * "วันนี้กินอะไรไปบ้าง" — ลิสต์ทุกรายการที่พิมพ์ แยกตามมื้อ พร้อม **เลขกำกับ**.
 *
 * เลขนับต่อเนื่องทั้งวัน (ไม่รีเซ็ตรายมื้อ) และเรียงตามเวลาที่บันทึก — ตัวเดียวกับที่
 * `ลบกิน <เลข>` ใช้อ้างอิง จึงต้องตรงกับลำดับใน getDayEntries() เสมอ ไม่งั้นผู้ใช้จะลบผิดรายการ.
 *
 * ต่างจาก buildDayCard ตรงที่การ์ดนี้ตอบคำถาม "กินอะไร" (ส่วนประกอบ) ส่วนการ์ดสรุปตอบ
 * "ได้สารอาหารเท่าไร" (ตัวเลข) — เลยไม่มีโดนัทในนี้ ให้ที่ว่างกับรายการแทน.
 */
export function buildDayDetailCard(
  rows: MealEntryRow[],
  occurredOn: string,
  manageUrl?: string
): OutboundMessage {
  if (rows.length === 0) {
    return {
      type: "text",
      text: `ยังไม่มีบันทึกอาหารของ ${formatThaiDate(occurredOn)}\n\nพิมพ์แบบนี้ได้เลย:\nกิน เช้า\nข้าวสวย 100g\nไข่ต้ม 2 ฟอง`,
      quickReply: mealQuickReply(),
    };
  }

  const total = rows.reduce(
    (a, r) => ({
      kcal: a.kcal + Number(r.kcal),
      carbG: a.carbG + Number(r.carb_g),
      proteinG: a.proteinG + Number(r.protein_g),
      fatG: a.fatG + Number(r.fat_g),
    }),
    { kcal: 0, carbG: 0, proteinG: 0, fatG: 0 }
  );

  const body: Record<string, unknown>[] = [];
  const order: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

  // เลขกำกับต้องนับจากลำดับ "ทั้งวัน" ตามเวลาบันทึก — map ไว้ก่อนแล้วค่อยแยกมื้อ
  const numbered = rows.map((row, i) => ({ row, no: i + 1 }));

  for (const slot of order) {
    const inSlot = numbered.filter((n) => n.row.meal_slot === slot);
    if (inSlot.length === 0) continue;

    const slotKcal = inSlot.reduce((a, n) => a + Number(n.row.kcal), 0);

    body.push({
      type: "box",
      layout: "horizontal",
      margin: body.length === 0 ? "none" : "xl",
      contents: [
        {
          type: "text",
          text: `${SLOT_EMOJI[slot]} ${SLOT_LABEL[slot]}`,
          size: FS.section,
          weight: "bold",
          color: NEUTRAL.text,
          flex: 5,
        },
        {
          type: "text",
          text: `${formatKcal(slotKcal)} kcal`,
          size: FS.label,
          color: NEUTRAL.muted,
          align: "end",
          flex: 4,
        },
      ],
    });

    for (const { row, no } of inSlot) {
      const m = rowMacros(row);
      body.push({
        type: "box",
        layout: "horizontal",
        margin: "md",
        spacing: "sm",
        contents: [
          // เลขนี้คือสิ่งที่พิมพ์ต่อท้าย "ลบกิน" ได้เลย
          {
            type: "text",
            text: `${no}.`,
            size: FS.meta,
            color: NEUTRAL.muted,
            flex: 1,
          },
          {
            type: "box",
            layout: "vertical",
            flex: 12,
            contents: [
              {
                type: "text",
                text: `${row.food_source === "ai-estimate" ? "🤖 " : ""}${row.food_name}${
                  row.resolved ? "" : " (ยังไม่รู้จัก)"
                }`,
                size: FS.body,
                weight: "bold",
                color: row.resolved ? NEUTRAL.text : NEUTRAL.muted,
                wrap: true,
              },
              {
                type: "text",
                text: `${formatQty(row)}${
                  row.grams === null ? "" : ` ≈ ${formatGrams(Number(row.grams))} g`
                }  ·  C ${formatGrams(m.carbG)} · P ${formatGrams(m.proteinG)} · F ${formatGrams(m.fatG)}`,
                size: FS.meta,
                color: NEUTRAL.muted,
                wrap: true,
              },
            ],
          },
          {
            type: "text",
            text: `${formatKcal(m.kcal)}`,
            size: FS.label,
            color: NEUTRAL.text,
            weight: "bold",
            align: "end",
            flex: 4,
          },
        ],
      });
    }
  }

  body.push(softSep("xl"));
  body.push({
    type: "text",
    text: "ลบรายการไหน พิมพ์เลขต่อท้ายได้เลย เช่น  ลบกิน 2\nลบทั้งมื้อ: ลบกิน เช้า  ·  ลบทั้งวัน: ลบกินทั้งวัน\nลบผิด? พิมพ์  กู้กิน  เอากลับคืนได้",
    size: FS.meta,
    color: NEUTRAL.muted,
    wrap: true,
    margin: "lg",
  });

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: MEAL_ACCENT,
      eyebrow: `🍽️ รายละเอียด · ${formatThaiDate(occurredOn)}`,
      heroLabel: "รวมทั้งวัน",
      hero: `${formatKcal(total.kcal)} kcal`,
      subtitle: `${rows.length} รายการ  ·  C ${formatGrams(total.carbG)} · P ${formatGrams(
        total.proteinG
      )} · F ${formatGrams(total.fatG)} g`,
    }),
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      paddingTop: "12px",
      spacing: "none",
      contents: body,
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "sm",
      contents: [
        messageButton("📊 ดูสัดส่วนสารอาหาร", "สรุปกิน", MEAL_ACCENT.solid),
        ...(manageUrl
          ? [
              {
                type: "button",
                style: "link",
                height: "sm",
                action: { type: "uri", label: "✏️ แก้ไขบนเว็บ", uri: manageUrl },
              },
            ]
          : []),
      ],
    },
    styles: { header: headerStyle(MEAL_ACCENT), footer: footerStyle() },
  };

  return {
    type: "flex",
    altText: `รายละเอียดอาหาร ${formatThaiDate(occurredOn)} — ${rows.length} รายการ ${formatKcal(total.kcal)} kcal`,
    contents: bubble,
    quickReply: mealQuickReply(),
  };
}

/** ยืนยันการลบหลายรายการ — บอกชัดว่าลบอะไรไป และเอากลับคืนยังไง */
export function buildDeletedText(rows: MealEntryRow[], occurredOn: string): OutboundMessage {
  if (rows.length === 0) {
    return {
      type: "text",
      text: `ไม่มีรายการให้ลบใน ${formatThaiDate(occurredOn)}\n\nดูว่ามีอะไรบ้าง: รายละเอียดกิน`,
      quickReply: mealQuickReply(),
    };
  }

  const kcal = rows.reduce((a, r) => a + Number(r.kcal), 0);
  const names = rows.map((r) => `• ${r.food_name} (${SLOT_LABEL[r.meal_slot]})`).join("\n");

  return {
    type: "text",
    text: `🗑️ ลบแล้ว ${rows.length} รายการ · −${formatKcal(kcal)} kcal\n${names}\n\nลบผิด? พิมพ์  กู้กิน  เอากลับคืนได้ทั้งชุด`,
    quickReply: mealQuickReply(),
  };
}

/** ยืนยันการกู้คืน */
export function buildRestoredText(rows: MealEntryRow[]): OutboundMessage {
  if (rows.length === 0) {
    return {
      type: "text",
      text: "ไม่มีรายการที่ลบไว้ให้กู้คืน (ย้อนได้เฉพาะที่ลบภายใน 24 ชม.)",
      quickReply: mealQuickReply(),
    };
  }

  const kcal = rows.reduce((a, r) => a + Number(r.kcal), 0);
  const names = rows.map((r) => `• ${r.food_name} (${SLOT_LABEL[r.meal_slot]})`).join("\n");

  return {
    type: "text",
    text: `♻️ กู้คืนแล้ว ${rows.length} รายการ · +${formatKcal(kcal)} kcal\n${names}`,
    quickReply: mealQuickReply(),
  };
}

/** ลิงก์หน้าเว็บจัดการอาหาร — เตือนเรื่องความเป็นส่วนตัวเพราะโทเคนคือสิทธิ์ทั้งหมด */
export function buildMealLinkText(url: string): OutboundMessage {
  return {
    type: "text",
    text: `🍽️ จัดการอาหารของคุณ:\n${url}\n\nในเว็บทำได้: แก้ปริมาณ/มื้อ/ชื่ออาหาร · ลบและกู้คืน · ดูฐานข้อมูลอาหารทั้งหมด · สั่งให้ AI เรียนรู้อาหารใหม่\n\n⚠️ ลิงก์นี้เปิดไดอารี่อาหารของคุณคนเดียว — อย่าส่งต่อให้ใคร`,
    quickReply: mealQuickReply(),
  };
}

export function buildUndoText(row: MealEntryRow): OutboundMessage {
  return {
    type: "text",
    text: `↩️ ลบแล้ว: ${row.food_name} (${SLOT_LABEL[row.meal_slot]} ${formatThaiDate(
      row.occurred_on
    )}) −${formatKcal(Number(row.kcal))} kcal`,
    quickReply: mealQuickReply(),
  };
}
