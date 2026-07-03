// ───────────────────────────────────────────────────────────────────────────
// category-store.ts — per-target category customization (EunJod-style จัดการหมวด).
// DB ops against upl_ledger_categories, all scoped to a single target_id (one LINE
// chat/group = one ledger, exactly like ledger.ts / todo.ts). NO external API / LLM.
//
// Model (see migration 0006): a row exists ONLY when a target customizes a category —
// adds a custom one (is_custom=true), hides a built-in (hidden=true, is_custom=false), or
// overrides its emoji/sort. The "effective" list a target sees = built-in DEFAULTS (from
// categories.ts) with per-row overrides applied, then custom rows appended, ordered by sort.
// Recategorizing a transaction lives in ledger.ts (it just rewrites entries.category); this
// file only governs the PICKABLE list, never the stored strings on existing entries.
//
// "อื่นๆ" is the fallback bucket and can NEVER be hidden (categorizeLocal falls back to it).
// ───────────────────────────────────────────────────────────────────────────

import { getServiceClient } from "../../db";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  categoryEmoji,
  type LedgerKind,
} from "./categories";

/** ชื่อหมวด fallback — ห้ามซ่อน (categorizeLocal คืนค่านี้เมื่อไม่เจอหมวด) */
const FALLBACK_CATEGORY = "อื่นๆ";

/** หนึ่งหมวดที่ "มีผลจริง" ต่อ target — รวม built-in + override + custom แล้ว. */
export interface EffectiveCategory {
  name: string;
  emoji: string;
  kind: LedgerKind;
  hidden: boolean;
  isCustom: boolean;
}

/** แถวดิบจาก upl_ledger_categories (override ของ built-in หรือ custom ที่เพิ่มเอง). */
interface CategoryRow {
  id: string;
  name: string;
  kind: LedgerKind;
  emoji: string | null;
  sort: number;
  hidden: boolean;
  is_custom: boolean;
}

const CATEGORY_COLUMNS = "id, name, kind, emoji, sort, hidden, is_custom";

/** ปรับชื่อหมวดให้เทียบกัน: ตัดช่องว่างหัวท้าย (ชื่อหมวดไทยไม่ lowercase — คงตัวอักษรเดิม) */
function cleanName(s: string): string {
  return (s ?? "").trim();
}

/** รายการ built-in ตาม kind ("อื่นๆ" อยู่ท้ายสุดเสมอตาม categories.ts) */
function defaultsFor(kind: LedgerKind): readonly string[] {
  return kind === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

/** โหลดแถว customization ของ target+kind ครั้งเดียว (index → name สำหรับ merge) */
async function loadRows(targetId: string, kind: LedgerKind): Promise<CategoryRow[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_ledger_categories")
    .select(CATEGORY_COLUMNS)
    .eq("target_id", targetId)
    .eq("kind", kind);

  if (error) {
    throw new Error(
      `Failed to load upl_ledger_categories for target ${targetId} (${kind}): ${error.message}`
    );
  }
  return (data ?? []) as unknown as CategoryRow[];
}

/**
 * รายการหมวดที่มีผลจริงของ target ตาม kind — merge สามชั้น:
 *   1) เริ่มจาก built-in (EXPENSE_CATEGORIES / INCOME_CATEGORIES) ตามลำดับเดิม
 *   2) ทับด้วย override ต่อแถว (hidden flag, emoji) จาก upl_ledger_categories
 *   3) ต่อท้ายด้วยหมวด custom (is_custom=true)
 * emoji = row.emoji ?? categoryEmoji(name). เรียงตาม sort แล้วลำดับเดิม.
 * คืน "ทั้งหมด" (รวมที่ hidden พร้อม flag) เพื่อให้หน้าจัดการเปิดคืนได้ — ผู้เรียกที่ต้องการ
 * "ตัวเลือก" (dropdown) ให้กรอง !hidden เอง. "อื่นๆ" ถูกบังคับ hidden=false เสมอ.
 */
export async function listEffectiveCategories(
  targetId: string,
  kind: LedgerKind
): Promise<EffectiveCategory[]> {
  const rows = await loadRows(targetId, kind);
  const byName = new Map<string, CategoryRow>();
  for (const r of rows) byName.set(r.name, r);

  const out: EffectiveCategory[] = [];
  const seen = new Set<string>();

  // 1) + 2) built-in ตามลำดับเดิม (sort เริ่มที่ 0,1,2,… เพื่อคงลำดับ) ทับด้วย override
  const defaults = defaultsFor(kind);
  const merged: { cat: EffectiveCategory; sort: number; order: number }[] = [];
  defaults.forEach((name, i) => {
    const row = byName.get(name);
    const isFallback = name === FALLBACK_CATEGORY;
    merged.push({
      cat: {
        name,
        emoji: row?.emoji ?? categoryEmoji(name),
        kind,
        hidden: isFallback ? false : Boolean(row?.hidden),
        isCustom: false,
      },
      sort: row?.sort ?? i, // built-in ที่ยังไม่ถูก override ใช้ลำดับเดิม (0..n)
      order: i,
    });
    seen.add(name);
  });

  // 3) custom rows (is_custom=true) ที่ไม่ทับ built-in — ต่อท้าย
  rows
    .filter((r) => r.is_custom && !seen.has(r.name))
    .forEach((r, i) => {
      merged.push({
        cat: {
          name: r.name,
          emoji: r.emoji ?? categoryEmoji(r.name),
          kind,
          hidden: r.name === FALLBACK_CATEGORY ? false : Boolean(r.hidden),
          isCustom: true,
        },
        sort: r.sort ?? 100 + i,
        order: defaults.length + i,
      });
    });

  // เรียงตาม sort แล้วลำดับเดิม (เสถียร)
  merged.sort((a, b) => (a.sort !== b.sort ? a.sort - b.sort : a.order - b.order));
  for (const m of merged) out.push(m.cat);
  return out;
}

/**
 * เพิ่มหมวด custom (is_custom=true). ถ้าชื่อนี้มีอยู่แล้ว (รวมถึง built-in ที่ถูกซ่อน) →
 * เปิดคืน/settle แทนการสร้างซ้ำ (unhide). Trim ชื่อ; ปฏิเสธชื่อว่าง.
 * คืนรายการ effective ล่าสุดของ kind นั้น.
 */
export async function addCategory(
  targetId: string,
  kind: LedgerKind,
  name: string,
  emoji?: string
): Promise<EffectiveCategory[]> {
  const clean = cleanName(name);
  if (!clean) throw new Error("category name is required");

  const supabase = getServiceClient();
  const isBuiltIn = defaultsFor(kind).includes(clean);

  // มี built-in ชื่อนี้อยู่แล้ว — ให้แน่ใจว่า "ไม่ถูกซ่อน" (unhide) + อัปเดต emoji ถ้าส่งมา
  if (isBuiltIn) {
    await setCategoryHidden(targetId, kind, clean, false);
    if (emoji !== undefined) {
      await updateCategory(targetId, kind, clean, { emoji });
    }
    return listEffectiveCategories(targetId, kind);
  }

  // upsert row: ถ้ามีอยู่แล้ว (custom เดิม หรือ override) → เปิดคืน (hidden=false, is_custom=true)
  const { error } = await supabase
    .from("upl_ledger_categories")
    .upsert(
      {
        target_id: targetId,
        name: clean,
        kind,
        emoji: emoji ?? null,
        hidden: false,
        is_custom: true,
      },
      { onConflict: "target_id,name,kind" }
    );

  if (error) {
    throw new Error(`Failed to add category "${clean}" for target ${targetId}: ${error.message}`);
  }
  return listEffectiveCategories(targetId, kind);
}

/**
 * ซ่อน/เปิดหมวด — upsert แถว override (built-in → is_custom=false) ตั้ง hidden.
 * ปฏิเสธการซ่อน "อื่นๆ" (เป็น fallback). คืนรายการ effective ล่าสุดของ kind.
 */
export async function setCategoryHidden(
  targetId: string,
  kind: LedgerKind,
  name: string,
  hidden: boolean
): Promise<EffectiveCategory[]> {
  const clean = cleanName(name);
  if (!clean) throw new Error("category name is required");
  if (hidden && clean === FALLBACK_CATEGORY) {
    throw new Error(`ไม่สามารถซ่อนหมวด "${FALLBACK_CATEGORY}" ได้ (เป็นหมวดสำรอง)`);
  }

  const supabase = getServiceClient();
  const isBuiltIn = defaultsFor(kind).includes(clean);

  // ดึงแถวเดิม (ถ้ามี) เพื่อคง is_custom / emoji ไว้ตอน upsert
  const { data: existing, error: selErr } = await supabase
    .from("upl_ledger_categories")
    .select(CATEGORY_COLUMNS)
    .eq("target_id", targetId)
    .eq("kind", kind)
    .eq("name", clean)
    .maybeSingle();
  if (selErr) {
    throw new Error(`Failed to read category "${clean}" for target ${targetId}: ${selErr.message}`);
  }
  const prev = existing as unknown as CategoryRow | null;

  const { error } = await supabase
    .from("upl_ledger_categories")
    .upsert(
      {
        target_id: targetId,
        name: clean,
        kind,
        emoji: prev?.emoji ?? null,
        sort: prev?.sort ?? (isBuiltIn ? defaultsFor(kind).indexOf(clean) : 100),
        hidden,
        // custom เดิมคง is_custom=true; built-in override เป็น is_custom=false
        is_custom: prev?.is_custom ?? !isBuiltIn,
      },
      { onConflict: "target_id,name,kind" }
    );

  if (error) {
    throw new Error(
      `Failed to ${hidden ? "hide" : "unhide"} category "${clean}" for target ${targetId}: ${error.message}`
    );
  }
  return listEffectiveCategories(targetId, kind);
}

/**
 * แก้หมวด: emoji / เปลี่ยนชื่อ (newName) / sort.
 * - built-in: แก้ได้เฉพาะ emoji + sort (rename ไม่รองรับ — ให้ซ่อนแล้วเพิ่มใหม่แทน)
 * - custom : แก้ได้ทั้งหมด. เมื่อ rename ต้อง migrate entries เดิม:
 *     update upl_ledger_entries set category=newName where target_id and category=oldName
 * คืนรายการ effective ล่าสุดของ kind.
 */
export async function updateCategory(
  targetId: string,
  kind: LedgerKind,
  name: string,
  patch: { emoji?: string; newName?: string; sort?: number }
): Promise<EffectiveCategory[]> {
  const clean = cleanName(name);
  if (!clean) throw new Error("category name is required");

  const supabase = getServiceClient();
  const isBuiltIn = defaultsFor(kind).includes(clean);
  const newName = patch.newName !== undefined ? cleanName(patch.newName) : undefined;

  // rename อนุญาตเฉพาะ custom (built-in คงชื่อไว้เพื่อให้กฎ categorizeLocal ยังอ้างอิงได้)
  if (newName !== undefined && newName !== clean) {
    if (isBuiltIn) {
      throw new Error(`เปลี่ยนชื่อหมวดพื้นฐาน "${clean}" ไม่ได้ (ปรับได้เฉพาะอีโมจิ/ซ่อน)`);
    }
    if (!newName) throw new Error("ชื่อหมวดใหม่ต้องไม่ว่าง");
  }

  // ดึงแถวเดิม (built-in อาจยังไม่มีแถว → ต้อง upsert เป็น override เมื่อแก้ emoji/sort)
  const { data: existing, error: selErr } = await supabase
    .from("upl_ledger_categories")
    .select(CATEGORY_COLUMNS)
    .eq("target_id", targetId)
    .eq("kind", kind)
    .eq("name", clean)
    .maybeSingle();
  if (selErr) {
    throw new Error(`Failed to read category "${clean}" for target ${targetId}: ${selErr.message}`);
  }
  const prev = existing as unknown as CategoryRow | null;

  const nextName = newName !== undefined && newName ? newName : clean;
  const { error: upErr } = await supabase
    .from("upl_ledger_categories")
    .upsert(
      {
        target_id: targetId,
        name: nextName,
        kind,
        emoji: patch.emoji !== undefined ? patch.emoji : prev?.emoji ?? null,
        sort:
          patch.sort !== undefined
            ? patch.sort
            : prev?.sort ?? (isBuiltIn ? defaultsFor(kind).indexOf(clean) : 100),
        hidden: prev?.hidden ?? false,
        is_custom: prev?.is_custom ?? !isBuiltIn,
      },
      { onConflict: "target_id,name,kind" }
    );

  if (upErr) {
    throw new Error(`Failed to update category "${clean}" for target ${targetId}: ${upErr.message}`);
  }

  // rename: ลบแถวชื่อเดิม (ถ้าเปลี่ยนชื่อจริง) + migrate entries เดิมไปชื่อใหม่
  if (nextName !== clean) {
    const { error: delErr } = await supabase
      .from("upl_ledger_categories")
      .delete()
      .eq("target_id", targetId)
      .eq("kind", kind)
      .eq("name", clean);
    if (delErr) {
      throw new Error(
        `Failed to remove old category row "${clean}" for target ${targetId}: ${delErr.message}`
      );
    }
    const { error: migErr } = await supabase
      .from("upl_ledger_entries")
      .update({ category: nextName })
      .eq("target_id", targetId)
      .eq("category", clean);
    if (migErr) {
      throw new Error(
        `Failed to migrate entries "${clean}"→"${nextName}" for target ${targetId}: ${migErr.message}`
      );
    }
  }

  return listEffectiveCategories(targetId, kind);
}

/**
 * ลบหมวด custom เท่านั้น — ลบแถว + reassign entries เดิมไป "อื่นๆ":
 *   update upl_ledger_entries set category='อื่นๆ' where target_id and category=name
 * built-in ซ่อนได้เท่านั้น ลบไม่ได้ (โยน error). คืนรายการ effective ล่าสุดของ kind.
 */
export async function deleteCategory(
  targetId: string,
  kind: LedgerKind,
  name: string
): Promise<EffectiveCategory[]> {
  const clean = cleanName(name);
  if (!clean) throw new Error("category name is required");
  if (defaultsFor(kind).includes(clean)) {
    throw new Error(`ลบหมวดพื้นฐาน "${clean}" ไม่ได้ — ซ่อนได้เท่านั้น`);
  }

  const supabase = getServiceClient();

  // ต้องเป็น custom จริง (กันลบ override ของ built-in โดยบังเอิญ)
  const { data: existing, error: selErr } = await supabase
    .from("upl_ledger_categories")
    .select(CATEGORY_COLUMNS)
    .eq("target_id", targetId)
    .eq("kind", kind)
    .eq("name", clean)
    .maybeSingle();
  if (selErr) {
    throw new Error(`Failed to read category "${clean}" for target ${targetId}: ${selErr.message}`);
  }
  const prev = existing as unknown as CategoryRow | null;
  if (!prev || !prev.is_custom) {
    throw new Error(`ลบได้เฉพาะหมวดที่เพิ่มเอง — "${clean}" ไม่ใช่หมวด custom`);
  }

  const { error: delErr } = await supabase
    .from("upl_ledger_categories")
    .delete()
    .eq("target_id", targetId)
    .eq("kind", kind)
    .eq("name", clean);
  if (delErr) {
    throw new Error(`Failed to delete category "${clean}" for target ${targetId}: ${delErr.message}`);
  }

  // ย้าย entries เดิมของหมวดนี้ไปหมวดสำรอง "อื่นๆ"
  const { error: reErr } = await supabase
    .from("upl_ledger_entries")
    .update({ category: FALLBACK_CATEGORY })
    .eq("target_id", targetId)
    .eq("category", clean);
  if (reErr) {
    throw new Error(
      `Failed to reassign entries of "${clean}"→"${FALLBACK_CATEGORY}" for target ${targetId}: ${reErr.message}`
    );
  }

  return listEffectiveCategories(targetId, kind);
}
