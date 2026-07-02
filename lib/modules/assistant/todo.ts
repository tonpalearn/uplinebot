import { getServiceClient } from "../../db";
import type { OutboundMessage } from "../types";

/**
 * Todo Manager — CRUD against upl_todos (SYSTEM-DESIGN.md §3 DDL), scoped to a single
 * target_id (per-chat/group, per TenantContext). Intent parsing lives in handler.ts;
 * this file only knows how to talk to Supabase and format the Thai replies.
 */

export interface ParsedTodoIntent {
  action: "add" | "list" | "done" | "delete" | "delete_all";
  /** For "add": one entry per line to insert. */
  items?: string[];
  /** For "done"/"delete": 1-based indexes as shown in the last list reply. */
  indexes?: number[];
}

const BULLET = "•";

function formatTodoLine(index: number, content: string, done: boolean): string {
  const box = done ? "[x]" : "[ ]";
  return `${index}. ${box} ${content}`;
}

/** Fetches the target's open+done todos ordered for stable index numbering (oldest first). */
async function fetchTodos(targetId: string) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_todos")
    .select("id, content, done, due_date, created_at")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load upl_todos for target ${targetId}: ${error.message}`);
  }
  return data ?? [];
}

/** เพิ่มงาน — insert one row per line. */
export async function addTodos(targetId: string, items: string[]): Promise<OutboundMessage[]> {
  const supabase = getServiceClient();
  const rows = items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((content) => ({ target_id: targetId, content }));

  if (rows.length === 0) {
    return [{ type: "text", text: "ไม่พบข้อความงานที่จะเพิ่ม ลองพิมพ์ใหม่ เช่น \"เพิ่ม ซื้อของ\"" }];
  }

  const { error } = await supabase.from("upl_todos").insert(rows);
  if (error) {
    return [{ type: "text", text: `เพิ่มงานไม่สำเร็จ: ${error.message}` }];
  }

  const lines = rows.map((r, i) => `${BULLET} ${r.content}`);
  const summary =
    rows.length === 1
      ? `เพิ่มงานแล้ว:\n${lines[0]}`
      : `เพิ่ม ${rows.length} งานแล้ว:\n${lines.join("\n")}`;

  return [{ type: "text", text: summary }];
}

/** งานวันนี้ / list — returns a plain-text checklist, index-numbered oldest→newest. */
export async function listTodos(targetId: string): Promise<OutboundMessage[]> {
  const todos = await fetchTodos(targetId);

  if (todos.length === 0) {
    return [{ type: "text", text: "ยังไม่มีงานในรายการ พิมพ์ \"เพิ่ม [ชื่องาน]\" เพื่อเริ่มได้เลย" }];
  }

  const lines = todos.map((t, i) => formatTodoLine(i + 1, t.content, t.done));
  const openCount = todos.filter((t) => !t.done).length;

  return [
    {
      type: "text",
      text: `รายการงาน (ค้าง ${openCount}/${todos.length}):\n${lines.join("\n")}`,
    },
  ];
}

/** เสร็จ [เลข] — marks the given 1-based indexes as done. */
export async function completeTodos(targetId: string, indexes: number[]): Promise<OutboundMessage[]> {
  const todos = await fetchTodos(targetId);
  const supabase = getServiceClient();

  const targets = indexes
    .map((i) => todos[i - 1])
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  if (targets.length === 0) {
    return [{ type: "text", text: "ไม่พบงานตามเลขที่ระบุ ลองพิมพ์ \"งานวันนี้\" เพื่อดูเลขงานอีกครั้ง" }];
  }

  const { error } = await supabase
    .from("upl_todos")
    .update({ done: true })
    .in(
      "id",
      targets.map((t) => t.id)
    );

  if (error) {
    return [{ type: "text", text: `อัปเดตสถานะไม่สำเร็จ: ${error.message}` }];
  }

  const lines = targets.map((t) => `${BULLET} ${t.content}`);
  return [{ type: "text", text: `ทำเสร็จแล้ว:\n${lines.join("\n")}` }];
}

/** ลบ [เลข] / ลบทั้งหมด — deletes the given indexes, or every todo for the target. */
export async function deleteTodos(
  targetId: string,
  opts: { indexes?: number[]; all?: boolean }
): Promise<OutboundMessage[]> {
  const supabase = getServiceClient();

  if (opts.all) {
    const { error, count } = await supabase
      .from("upl_todos")
      .delete({ count: "exact" })
      .eq("target_id", targetId);

    if (error) {
      return [{ type: "text", text: `ลบงานไม่สำเร็จ: ${error.message}` }];
    }
    return [{ type: "text", text: count ? `ลบงานทั้งหมด ${count} รายการแล้ว` : "ไม่มีงานให้ลบ" }];
  }

  const todos = await fetchTodos(targetId);
  const targets = (opts.indexes ?? [])
    .map((i) => todos[i - 1])
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  if (targets.length === 0) {
    return [{ type: "text", text: "ไม่พบงานตามเลขที่ระบุ ลองพิมพ์ \"งานวันนี้\" เพื่อดูเลขงานอีกครั้ง" }];
  }

  const { error } = await supabase
    .from("upl_todos")
    .delete()
    .in(
      "id",
      targets.map((t) => t.id)
    );

  if (error) {
    return [{ type: "text", text: `ลบงานไม่สำเร็จ: ${error.message}` }];
  }

  const lines = targets.map((t) => `${BULLET} ${t.content}`);
  return [{ type: "text", text: `ลบแล้ว:\n${lines.join("\n")}` }];
}

/**
 * Thai keyword intent matcher for the Todo Manager.
 * Supported surface (per SPEC.md §6.3 + handler TODO notes):
 * - "เพิ่ม <text>" (multi-line: first line's remainder + each following line = one todo each)
 * - "งานวันนี้" or "list" → list
 * - "เสร็จ <number>" (supports multiple numbers) → complete
 * - "ลบ <number(s)>" or "ลบทั้งหมด" → delete
 */
export function parseTodoIntent(text: string): ParsedTodoIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const firstLine = lines[0] ?? "";

  // ลบทั้งหมด
  if (/^ลบทั้งหมด$/i.test(firstLine)) {
    return { action: "delete_all" };
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

  // งานวันนี้ / list
  if (/^(งานวันนี้|list)$/i.test(firstLine)) {
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
