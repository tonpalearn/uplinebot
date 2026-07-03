import { getServiceClient } from "../../db";
import { categorizeLocal, type LedgerKind } from "./categories";
import type { ParsedEntry } from "./parse";

/**
 * Ledger DB ops — CRUD against upl_ledger_entries + upl_ledger_category_map, scoped to a
 * single target_id (per-chat/group, per TenantContext). One bot serves many groups; every
 * query here is filtered by target_id so entries never leak across targets (identical to
 * how todo.ts scopes upl_todos).
 *
 * Category resolution (addEntries): a learned per-target keyword in upl_ledger_category_map
 * wins first (the group taught it); otherwise the pure rule-based categorizeLocal() runs.
 * No external API / LLM anywhere.
 */

export interface LedgerRow {
  id: string;
  target_id: string;
  kind: LedgerKind;
  amount: number;
  category: string;
  note: string | null;
  raw_text: string | null;
  occurred_on: string; // YYYY-MM-DD
  created_at: string;
  deleted_at: string | null;
}

/** A learned keyword→category mapping row (per target + kind). */
interface CategoryMapRow {
  keyword: string;
  kind: LedgerKind;
  category: string;
}

const ENTRY_COLUMNS =
  "id, target_id, kind, amount, category, note, raw_text, occurred_on, created_at, deleted_at";

/** normalize เหมือน categories.ts เพื่อเทียบ learned-keyword กับ item (lowercase + ตัดช่องว่าง) */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").trim();
}

/**
 * Resolve a category for one item+kind: first check the target's learned keywords
 * (upl_ledger_category_map, forward-contains on the normalized item), else fall back to the
 * pure rule-based categorizeLocal(). `learned` is the pre-fetched map for this target+kind.
 */
function resolveCategory(item: string, kind: LedgerKind, learned: CategoryMapRow[]): string {
  const n = normalize(item);
  if (n) {
    // คำที่กลุ่มสอน: keyword เป็นส่วนหนึ่งของ item (เช่น สอน "เจ๊แดง" → หมวด "กิน")
    for (const row of learned) {
      if (row.kind !== kind) continue;
      const kw = normalize(row.keyword);
      if (kw.length >= 2 && n.includes(kw)) return row.category;
    }
  }
  return categorizeLocal(item, kind);
}

/**
 * เพิ่มหลายรายการ — resolve หมวดของแต่ละรายการ (learned keyword ก่อน แล้วค่อยกฎ),
 * insert ทั้งชุด, คืนแถวที่ insert แล้ว (เรียงตาม occurred_on แล้ว created_at).
 * ทุกแถวถูกผูก target_id จากพารามิเตอร์เสมอ ไม่เชื่อค่าจากที่อื่น.
 */
export async function addEntries(
  targetId: string,
  entries: ParsedEntry[]
): Promise<LedgerRow[]> {
  if (entries.length === 0) return [];
  const supabase = getServiceClient();

  // ดึงคำที่กลุ่มนี้สอนไว้ครั้งเดียว (target-scoped) แล้วใช้ resolve ทุกรายการ
  const { data: mapData } = await supabase
    .from("upl_ledger_category_map")
    .select("keyword, kind, category")
    .eq("target_id", targetId);
  const learned = (mapData ?? []) as unknown as CategoryMapRow[];

  const rows = entries.map((e) => ({
    target_id: targetId,
    kind: e.kind,
    amount: e.amount,
    category: resolveCategory(e.item, e.kind, learned),
    note: e.note,
    raw_text: e.item,
    occurred_on: e.occurredOn,
  }));

  const { data, error } = await supabase
    .from("upl_ledger_entries")
    .insert(rows)
    .select(ENTRY_COLUMNS);

  if (error) {
    throw new Error(`Failed to insert upl_ledger_entries for target ${targetId}: ${error.message}`);
  }

  const inserted = (data ?? []) as unknown as LedgerRow[];
  return sortEntries(inserted);
}

/**
 * ดึงรายการในช่วง [fromDate, toDate] (inclusive) ที่ยังไม่ถูกลบ (deleted_at is null),
 * เรียงตาม occurred_on แล้ว created_at.
 */
export async function getEntries(
  targetId: string,
  fromDate: string,
  toDate: string
): Promise<LedgerRow[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_ledger_entries")
    .select(ENTRY_COLUMNS)
    .eq("target_id", targetId)
    .is("deleted_at", null)
    .gte("occurred_on", fromDate)
    .lte("occurred_on", toDate)
    .order("occurred_on", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load upl_ledger_entries for target ${targetId}: ${error.message}`);
  }

  return (data ?? []) as unknown as LedgerRow[];
}

/**
 * ลบรายการล่าสุด (soft-delete: set deleted_at=now) ที่ยังไม่ถูกลบ — คืนแถวที่ลบ หรือ null.
 * "ล่าสุด" = created_at ใหม่สุด (ลำดับที่บันทึกเข้า ไม่ใช่วันที่เกิดรายการ).
 */
export async function deleteLast(targetId: string): Promise<LedgerRow | null> {
  const supabase = getServiceClient();

  const { data: latest, error: selErr } = await supabase
    .from("upl_ledger_entries")
    .select(ENTRY_COLUMNS)
    .eq("target_id", targetId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selErr) {
    throw new Error(`Failed to find latest entry for target ${targetId}: ${selErr.message}`);
  }
  if (!latest) return null;

  const row = latest as unknown as LedgerRow;
  const { error: updErr } = await supabase
    .from("upl_ledger_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("target_id", targetId);

  if (updErr) {
    throw new Error(`Failed to soft-delete entry ${row.id}: ${updErr.message}`);
  }

  return row;
}

/** occurred_on asc, created_at asc (deterministic tiebreak) — matches getEntries ordering. */
function sortEntries(rows: LedgerRow[]): LedgerRow[] {
  return rows.slice().sort((a, b) => {
    if (a.occurred_on !== b.occurred_on) return a.occurred_on.localeCompare(b.occurred_on);
    return a.created_at.localeCompare(b.created_at);
  });
}
