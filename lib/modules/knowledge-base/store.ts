import { getServiceClient } from "../../db";

/**
 * Knowledge Base DB ops — CRUD + retrieval against upl_km_entries / upl_km_unanswered, scoped
 * per **TENANT** (a business's whole KB, shared across all its groups). Unlike the ledger (which
 * scopes by target_id), every query here filters by tenant_id so one business's KB never leaks
 * into another's.
 *
 * Retrieval (searchKb) is self-hosted with NO paid API: pg_trgm trigram similarity via the
 * km_search() SQL function (migration 0010), which returns each candidate's score so we threshold
 * in TypeScript (KM_MATCH_THRESHOLD) — Thai trigram scores run low, so the threshold is tunable
 * here without a migration.
 */

export interface KmEntry {
  id: string;
  tenant_id: string;
  question: string;
  answer: string;
  keywords: string | null;
  /**
   * Exact-match triggers (one per line OR comma-separated) — a message that EXACTLY equals any
   * of these (trimmed, case-insensitive) is answered directly, with NO "ถาม" prefix needed.
   * Matched by the km_exact() SQL function (migration 0011). null = no triggers on this entry.
   */
  trigger_keywords: string | null;
  source: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** One ranked hit from km_search() — a subset of KmEntry plus the trigram score. */
export interface KmSearchHit {
  id: string;
  question: string;
  answer: string;
  source: string;
  score: number;
}

/** The entry an exact trigger resolves to (km_exact() row) — no score, it's an exact hit. */
export interface KmExactHit {
  id: string;
  question: string;
  answer: string;
  source: string;
}

export interface KmEntryInput {
  question: string;
  answer: string;
  keywords?: string | null;
  trigger_keywords?: string | null;
  source?: string;
}

export interface KmEntryPatch {
  question?: string;
  answer?: string;
  keywords?: string | null;
  trigger_keywords?: string | null;
  enabled?: boolean;
}

/**
 * Minimum trigram similarity for a KB hit to count as an "answer". START AT 0.12 — Thai text has
 * no word boundaries, so pg_trgm scores are much lower than on English; 0.3 (pg_trgm's default `%`
 * threshold) would reject almost every real Thai match. TUNE THIS: raise it if the bot answers
 * with loosely-related entries; lower it if good matches are missed. (Retrieval quality on Thai
 * trigrams is the main risk of Phase 1 — Phase 2 can add embeddings for semantic recall.)
 */
export const KM_MATCH_THRESHOLD = 0.12;

/**
 * Similarity above which a newly-asked unanswered question is treated as "the same" as an existing
 * unresolved one (bump ask_count instead of inserting a duplicate). Higher than the retrieval
 * threshold because this is near-duplicate detection, not fuzzy recall. Computed with a JS trigram
 * Jaccard (approximates pg_trgm) so no extra SQL function is needed for the housekeeping queue.
 */
const UNANSWERED_DEDUP_THRESHOLD = 0.5;

const ENTRY_COLUMNS =
  "id, tenant_id, question, answer, keywords, trigger_keywords, source, enabled, created_at, updated_at";

// ── writes ───────────────────────────────────────────────────────────────────────────────────

/** เพิ่มความรู้หนึ่งรายการ (source เริ่มต้น 'manual'); คืนแถวที่บันทึกแล้ว. */
export async function addEntry(tenantId: string, input: KmEntryInput): Promise<KmEntry> {
  const supabase = getServiceClient();
  const row = {
    tenant_id: tenantId,
    question: input.question.trim(),
    answer: input.answer.trim(),
    keywords: input.keywords?.trim() || null,
    trigger_keywords: input.trigger_keywords?.trim() || null,
    source: input.source?.trim() || "manual",
  };

  const { data, error } = await supabase
    .from("upl_km_entries")
    .insert(row)
    .select(ENTRY_COLUMNS)
    .single();

  if (error) {
    throw new Error(`Failed to insert upl_km_entries for tenant ${tenantId}: ${error.message}`);
  }
  return data as unknown as KmEntry;
}

/** เพิ่มความรู้หลายรายการ (ใช้ตอน chunk เอกสาร); ข้ามรายการที่ question/answer ว่าง. คืนแถวที่บันทึก. */
export async function addEntries(tenantId: string, inputs: KmEntryInput[]): Promise<KmEntry[]> {
  const rows = inputs
    .map((i) => ({
      tenant_id: tenantId,
      question: (i.question ?? "").trim(),
      answer: (i.answer ?? "").trim(),
      keywords: i.keywords?.trim() || null,
      trigger_keywords: i.trigger_keywords?.trim() || null,
      source: i.source?.trim() || "manual",
    }))
    .filter((r) => r.question && r.answer);

  if (rows.length === 0) return [];

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_km_entries")
    .insert(rows)
    .select(ENTRY_COLUMNS);

  if (error) {
    throw new Error(`Failed to bulk-insert upl_km_entries for tenant ${tenantId}: ${error.message}`);
  }
  return (data ?? []) as unknown as KmEntry[];
}

/** แก้ไขความรู้หนึ่งรายการ — scope ด้วย (id, tenant_id) เสมอ. คืนแถวที่อัปเดต หรือ null ถ้าไม่พบ. */
export async function updateEntry(
  id: string,
  tenantId: string,
  patch: KmEntryPatch
): Promise<KmEntry | null> {
  const patchRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.question !== undefined) patchRow.question = patch.question.trim();
  if (patch.answer !== undefined) patchRow.answer = patch.answer.trim();
  if (patch.keywords !== undefined) patchRow.keywords = patch.keywords?.trim() || null;
  if (patch.trigger_keywords !== undefined)
    patchRow.trigger_keywords = patch.trigger_keywords?.trim() || null;
  if (patch.enabled !== undefined) patchRow.enabled = patch.enabled;

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_km_entries")
    .update(patchRow)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select(ENTRY_COLUMNS)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update upl_km_entries ${id} for tenant ${tenantId}: ${error.message}`);
  }
  return (data as unknown as KmEntry) ?? null;
}

/** ลบความรู้หนึ่งรายการ (hard delete) — scope ด้วย (id, tenant_id). คืน true ถ้าลบสำเร็จ. */
export async function deleteEntry(id: string, tenantId: string): Promise<boolean> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_km_entries")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to delete upl_km_entries ${id} for tenant ${tenantId}: ${error.message}`);
  }
  return Boolean(data);
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────

/** ความรู้ทั้งหมดของ tenant (ใหม่สุดก่อน). */
export async function listEntries(tenantId: string): Promise<KmEntry[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_km_entries")
    .select(ENTRY_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list upl_km_entries for tenant ${tenantId}: ${error.message}`);
  }
  return (data ?? []) as unknown as KmEntry[];
}

/**
 * ค้นคลังความรู้ด้วย trigram similarity (ผ่าน km_search RPC) — คืน top-N ที่คะแนน ≥ threshold,
 * เรียงคะแนนมาก→น้อยแล้ว. query ว่าง → [].
 */
export async function searchKb(
  tenantId: string,
  query: string,
  limit = 3
): Promise<KmSearchHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];

  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("km_search", {
    p_tenant: tenantId,
    p_query: q,
    p_limit: limit,
  });

  if (error) {
    throw new Error(`km_search failed for tenant ${tenantId}: ${error.message}`);
  }

  const hits = (data ?? []) as unknown as KmSearchHit[];
  return hits.filter((h) => typeof h.score === "number" && h.score >= KM_MATCH_THRESHOLD);
}

/**
 * หา entry ที่ "คำที่พิมพ์มาตรงเป๊ะ" กับ trigger keyword ตัวใดตัวหนึ่ง (ผ่าน km_exact RPC, migration 0011)
 * — trim + lowercase แล้วเทียบทั้งคำ (ไม่ใช่ substring). ใช้ตอบทันทีโดยไม่ต้องมีคำนำหน้า "ถาม".
 * text ว่าง → null; ไม่มีตัวไหนตรง → null (เพื่อให้บอทเงียบกับข้อความทั่วไปที่ไม่ใช่ trigger).
 */
export async function matchExactTrigger(
  tenantId: string,
  text: string
): Promise<KmExactHit | null> {
  const t = (text ?? "").trim();
  if (!t) return null;

  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("km_exact", { p_tenant: tenantId, p_text: t });

  if (error) {
    throw new Error(`km_exact failed for tenant ${tenantId}: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as KmExactHit[];
  return rows[0] ?? null;
}

// ── unanswered queue (learning loop) ───────────────────────────────────────────────────────────

interface UnansweredRow {
  id: string;
  question: string;
  ask_count: number;
}

/** แถวคิวคำถามที่ตอบไม่ได้ (สำหรับหน้าเว็บแอดมิน). */
export interface KmUnanswered {
  id: string;
  question: string;
  target_id: string | null;
  ask_count: number;
  resolved: boolean;
  created_at: string;
  last_asked_at: string;
}

const UNANSWERED_COLUMNS =
  "id, question, target_id, ask_count, resolved, created_at, last_asked_at";

/** คำถามที่ยังตอบไม่ได้ (unresolved) ของ tenant — ถามบ่อยก่อน แล้วล่าสุดก่อน. */
export async function listUnanswered(tenantId: string): Promise<KmUnanswered[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_km_unanswered")
    .select(UNANSWERED_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("resolved", false)
    .order("ask_count", { ascending: false })
    .order("last_asked_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list upl_km_unanswered for tenant ${tenantId}: ${error.message}`);
  }
  return (data ?? []) as unknown as KmUnanswered[];
}

/** ทำเครื่องหมายว่าแก้แล้ว (resolved) — scope ด้วย (id, tenant_id). คืน true ถ้าอัปเดตแถวได้. */
export async function resolveUnanswered(id: string, tenantId: string): Promise<boolean> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_km_unanswered")
    .update({ resolved: true })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve upl_km_unanswered ${id} for tenant ${tenantId}: ${error.message}`);
  }
  return Boolean(data);
}

/**
 * บันทึกคำถามที่ตอบไม่ได้ลงคิว "ให้แอดมินไปเพิ่มความรู้". ถ้ามีคำถามที่ยังไม่ถูกแก้และคล้ายกันมาก
 * (trigram ≥ dedup threshold) อยู่แล้ว → เพิ่ม ask_count + อัปเดต last_asked_at; ไม่งั้น insert ใหม่.
 */
export async function logUnanswered(
  tenantId: string,
  question: string,
  targetId?: string
): Promise<void> {
  const q = (question ?? "").trim();
  if (!q) return;

  const supabase = getServiceClient();
  const { data } = await supabase
    .from("upl_km_unanswered")
    .select("id, question, ask_count")
    .eq("tenant_id", tenantId)
    .eq("resolved", false);

  const rows = (data ?? []) as unknown as UnansweredRow[];
  let best: UnansweredRow | null = null;
  let bestScore = 0;
  for (const r of rows) {
    const s = trigramSimilarity(q, r.question);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }

  if (best && bestScore >= UNANSWERED_DEDUP_THRESHOLD) {
    await supabase
      .from("upl_km_unanswered")
      .update({ ask_count: (best.ask_count ?? 1) + 1, last_asked_at: new Date().toISOString() })
      .eq("id", best.id)
      .eq("tenant_id", tenantId);
    return;
  }

  await supabase.from("upl_km_unanswered").insert({
    tenant_id: tenantId,
    question: q,
    target_id: targetId ?? null,
  });
}

// ── trigram helper (JS approximation of pg_trgm, for the unanswered dedup only) ────────────────
/** เซ็ตของ 3-gram (lowercase, pad หัว 2 ท้าย 1 ช่องว่าง แบบ pg_trgm). */
function trigrams(s: string): Set<string> {
  const norm = "  " + s.toLowerCase().replace(/\s+/g, " ").trim() + " ";
  const set = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i++) set.add(norm.slice(i, i + 3));
  return set;
}

/** Jaccard ของเซ็ต trigram — ประมาณค่า similarity() ของ pg_trgm (ใช้เฉพาะ dedup คิวคำถาม). */
function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}
