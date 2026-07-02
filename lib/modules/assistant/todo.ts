import { getServiceClient } from "../../db";
import type { OutboundMessage } from "../types";
import { parseThaiDateTime, formatThaiDueAt } from "./datetime";
import { buildTodoListFlex, buildTodoListText, todoQuickReply, type TodoListItem } from "./flex";
import { getOrCreatePlanToken, planLinkUrl } from "../../plan-token";

/**
 * Todo Manager — CRUD against upl_todos (SYSTEM-DESIGN.md §3 DDL + migration 0003),
 * scoped to a single target_id (per-chat/group, per TenantContext). One bot serves many
 * groups; every query here is filtered by target_id so lists never leak across targets.
 *
 * The list is always shown as a numbered Flex card (buildTodoListFlex) and is renumbered
 * 1..N contiguously each time it is rendered — done/delete/reschedule reference those
 * visible numbers. Optional per-task due date/time is parsed from Thai natural language
 * (parseThaiDateTime) and stored as an absolute instant in due_at.
 */

// ── Intent surface (discriminated union the handler switches on) ─────────────────────────
export type ParsedTodoIntent =
  | { action: "add"; items: string[] }
  | { action: "list" }
  | { action: "done"; indexes: number[] }
  | { action: "delete"; indexes: number[] }
  | { action: "delete_all" }
  | { action: "reschedule"; index: number; whenText: string }
  | { action: "clear_done" }
  | { action: "plan" };

interface TodoRow {
  id: string;
  content: string;
  done: boolean;
  due_at: string | null;
  sort_order: number | null;
  created_at: string;
}

const BULLET = "•";

/**
 * Fetch the target's todos (open + done), ordered to match
 *   coalesce(sort_order, extract(epoch from created_at)::int) asc
 * so manual web reordering (sort_order) sticks and un-ordered rows fall back to
 * oldest-first by created_at. Sorting is done in JS (deterministic, mock-friendly) since
 * supabase-js .order() can't express the coalesce expression.
 */
async function fetchTodos(targetId: string): Promise<TodoRow[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_todos")
    .select("id, content, done, due_at, sort_order, created_at")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load upl_todos for target ${targetId}: ${error.message}`);
  }

  const rows = (data ?? []) as TodoRow[];
  return sortTodos(rows);
}

/** coalesce(sort_order, epoch(created_at)) ascending, created_at as a stable tiebreak. */
function sortTodos(rows: TodoRow[]): TodoRow[] {
  return rows.slice().sort((a, b) => {
    const ka = a.sort_order ?? epochSeconds(a.created_at);
    const kb = b.sort_order ?? epochSeconds(b.created_at);
    if (ka !== kb) return ka - kb;
    return a.created_at.localeCompare(b.created_at);
  });
}

function epochSeconds(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/** Map DB rows → numbered list items (1..N contiguous, in the sorted order). */
function toListItems(rows: TodoRow[]): TodoListItem[] {
  return rows.map((r, i) => ({
    n: i + 1,
    content: r.content,
    done: r.done,
    dueAt: r.due_at ? new Date(r.due_at) : null,
  }));
}

/** The refreshed Flex list reply, rebuilt from the current DB state. */
async function listReply(targetId: string, now: Date): Promise<OutboundMessage[]> {
  const rows = await fetchTodos(targetId);
  if (rows.length === 0) {
    return [
      {
        type: "text",
        text: "ยังไม่มีงานในรายการ พิมพ์ \"เพิ่ม [ชื่องาน]\" เพื่อเริ่มได้เลย",
        quickReply: todoQuickReply(),
      },
    ];
  }
  return [buildTodoListFlex(toListItems(rows), { now })];
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────

/** เพิ่มงาน — parse each line for an optional Thai date/time, insert, then show the Flex list. */
export async function addTodos(
  targetId: string,
  items: string[],
  now: Date = new Date()
): Promise<OutboundMessage[]> {
  const supabase = getServiceClient();

  const parsed = items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((raw) => {
      const { dueAt, cleanedText } = parseThaiDateTime(raw, now);
      const content = cleanedText.trim() || raw; // never insert an empty content
      return { content, dueAt };
    });

  if (parsed.length === 0) {
    return [
      {
        type: "text",
        text: "ไม่พบข้อความงานที่จะเพิ่ม ลองพิมพ์ใหม่ เช่น \"เพิ่ม ซื้อของ พรุ่งนี้ 14:00\"",
        quickReply: todoQuickReply(),
      },
    ];
  }

  const rows = parsed.map((p) => ({
    target_id: targetId,
    content: p.content,
    due_at: p.dueAt ? p.dueAt.toISOString() : null,
  }));

  const { error } = await supabase.from("upl_todos").insert(rows);
  if (error) {
    return [{ type: "text", text: `เพิ่มงานไม่สำเร็จ: ${error.message}` }];
  }

  return listReply(targetId, now);
}

/** งานวันนี้ / list — the numbered Flex card. */
export async function listTodos(targetId: string, now: Date = new Date()): Promise<OutboundMessage[]> {
  return listReply(targetId, now);
}

/** เสร็จ [เลข] — mark the given visible numbers done, then show the refreshed list. */
export async function completeTodos(
  targetId: string,
  indexes: number[],
  now: Date = new Date()
): Promise<OutboundMessage[]> {
  const rows = await fetchTodos(targetId);
  const supabase = getServiceClient();

  const targets = indexes
    .map((i) => rows[i - 1])
    .filter((t): t is TodoRow => Boolean(t));

  if (targets.length === 0) {
    return [
      {
        type: "text",
        text: "ไม่พบงานตามเลขที่ระบุ ลองพิมพ์ \"งานวันนี้\" เพื่อดูเลขงานอีกครั้ง",
        quickReply: todoQuickReply(),
      },
    ];
  }

  const { error } = await supabase
    .from("upl_todos")
    .update({ done: true })
    .in("id", targets.map((t) => t.id));

  if (error) {
    return [{ type: "text", text: `อัปเดตสถานะไม่สำเร็จ: ${error.message}` }];
  }

  return listReply(targetId, now);
}

/** ลบ [เลข] / ลบทั้งหมด — delete the given visible numbers, or every todo for the target. */
export async function deleteTodos(
  targetId: string,
  opts: { indexes?: number[]; all?: boolean },
  now: Date = new Date()
): Promise<OutboundMessage[]> {
  const supabase = getServiceClient();

  if (opts.all) {
    const { error } = await supabase
      .from("upl_todos")
      .delete({ count: "exact" })
      .eq("target_id", targetId);

    if (error) {
      return [{ type: "text", text: `ลบงานไม่สำเร็จ: ${error.message}` }];
    }
    return listReply(targetId, now);
  }

  const rows = await fetchTodos(targetId);
  const targets = (opts.indexes ?? [])
    .map((i) => rows[i - 1])
    .filter((t): t is TodoRow => Boolean(t));

  if (targets.length === 0) {
    return [
      {
        type: "text",
        text: "ไม่พบงานตามเลขที่ระบุ ลองพิมพ์ \"งานวันนี้\" เพื่อดูเลขงานอีกครั้ง",
        quickReply: todoQuickReply(),
      },
    ];
  }

  const { error } = await supabase
    .from("upl_todos")
    .delete()
    .in("id", targets.map((t) => t.id));

  if (error) {
    return [{ type: "text", text: `ลบงานไม่สำเร็จ: ${error.message}` }];
  }

  return listReply(targetId, now);
}

/**
 * เลื่อน [เลข] [เวลา] — set/replace the due date/time of the task at the given visible number.
 * If the when-text parses to nothing, the due_at is cleared (task becomes undated again).
 */
export async function rescheduleTodo(
  targetId: string,
  index: number,
  whenText: string,
  now: Date = new Date()
): Promise<OutboundMessage[]> {
  const rows = await fetchTodos(targetId);
  const target = rows[index - 1];

  if (!target) {
    return [
      {
        type: "text",
        text: "ไม่พบงานตามเลขที่ระบุ ลองพิมพ์ \"งานวันนี้\" เพื่อดูเลขงานอีกครั้ง",
        quickReply: todoQuickReply(),
      },
    ];
  }

  const { dueAt } = parseThaiDateTime(whenText, now);
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("upl_todos")
    .update({ due_at: dueAt ? dueAt.toISOString() : null, reminded_at: null })
    .eq("id", target.id);

  if (error) {
    return [{ type: "text", text: `เลื่อนกำหนดไม่สำเร็จ: ${error.message}` }];
  }

  return listReply(targetId, now);
}

/** ล้างที่เสร็จ — delete every done todo for the target, then show the refreshed list. */
export async function clearDone(targetId: string, now: Date = new Date()): Promise<OutboundMessage[]> {
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("upl_todos")
    .delete({ count: "exact" })
    .eq("target_id", targetId)
    .eq("done", true);

  if (error) {
    return [{ type: "text", text: `ล้างงานที่เสร็จไม่สำเร็จ: ${error.message}` }];
  }

  return listReply(targetId, now);
}

/**
 * วางแผน / ปฏิทิน / calendar — return the customer's calendar link + a short Thai instruction.
 * Mints (and persists) the target's plan token on first use.
 */
export async function planLink(targetId: string): Promise<OutboundMessage[]> {
  const token = await getOrCreatePlanToken(targetId);
  const url = planLinkUrl(token);
  return [
    {
      type: "text",
      text: `🗓️ วางแผนงานบนปฏิทินได้ที่นี่:\n${url}\n\nเปิดลิงก์เพื่อจัดลำดับงาน ตั้งวันเวลา และดูภาพรวมทั้งหมด (ลิงก์นี้เฉพาะกลุ่มนี้เท่านั้น)`,
      quickReply: todoQuickReply(),
    },
  ];
}

// ── Intent parsing ───────────────────────────────────────────────────────────────────────

/**
 * Thai keyword intent matcher for the Todo Manager. Returns a discriminated union
 * (or null when nothing matches). Supported surface:
 *   - "เพิ่ม <text>"                        → add (multi-line: first line remainder + each next line)
 *   - "งานวันนี้" | "รายการ" | "list" | "todo" → list
 *   - "รีเฟรช" | "relist"                    → list (explicit renumber)
 *   - "เสร็จ <numbers>"                      → done
 *   - "ลบ <numbers>" | "ลบทั้งหมด"           → delete / delete_all
 *   - "เลื่อน <number> <when>"               → reschedule
 *   - "ล้างที่เสร็จ" | "เคลียร์ที่เสร็จ"       → clear_done
 *   - "วางแผน" | "ปฏิทิน" | "calendar"       → plan
 */
export function parseTodoIntent(text: string): ParsedTodoIntent | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const firstLine = lines[0] ?? "";

  // ล้างที่เสร็จ / เคลียร์ที่เสร็จ
  if (/^(ล้างที่เสร็จ|ล้างงานที่เสร็จ|เคลียร์ที่เสร็จ|clear\s*done)$/i.test(firstLine)) {
    return { action: "clear_done" };
  }

  // วางแผน / ปฏิทิน / calendar
  if (/^(วางแผน|ปฏิทิน|calendar|plan)$/i.test(firstLine)) {
    return { action: "plan" };
  }

  // ลบทั้งหมด
  if (/^ลบทั้งหมด$/i.test(firstLine)) {
    return { action: "delete_all" };
  }

  // เลื่อน <number> <when>
  const rescheduleMatch = firstLine.match(/^(?:เลื่อน|เลื่อนงาน)\s+(\d+)\s+(.+)$/);
  if (rescheduleMatch) {
    const index = parseInt(rescheduleMatch[1], 10);
    const whenText = rescheduleMatch[2].trim();
    if (Number.isFinite(index) && index > 0 && whenText.length > 0) {
      return { action: "reschedule", index, whenText };
    }
  }

  // ลบ <numbers>
  const deleteMatch = firstLine.match(/^ลบ\s+(.+)$/);
  if (deleteMatch) {
    const indexes = extractNumbers(deleteMatch[1]);
    if (indexes.length > 0) {
      return { action: "delete", indexes };
    }
  }

  // เสร็จ <numbers>
  const doneMatch = firstLine.match(/^เสร็จ\s+(.+)$/);
  if (doneMatch) {
    const indexes = extractNumbers(doneMatch[1]);
    if (indexes.length > 0) {
      return { action: "done", indexes };
    }
  }

  // list / relist
  if (/^(งานวันนี้|รายการ|รายการงาน|list|todo|รีเฟรช|relist)$/i.test(firstLine)) {
    return { action: "list" };
  }

  // เพิ่ม <text> (multi-line: remainder of first line + all following lines)
  const addMatch = firstLine.match(/^เพิ่ม\s+(.+)$/);
  if (addMatch) {
    const items = [addMatch[1], ...lines.slice(1)];
    return { action: "add", items };
  }

  return null;
}

function extractNumbers(s: string): number[] {
  const matches = s.match(/\d+/g);
  if (!matches) return [];
  return matches.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0);
}

// Re-exported so callers/tests that want the raw formatters don't reach into ./flex or ./datetime.
export { formatThaiDueAt, buildTodoListText, BULLET };
