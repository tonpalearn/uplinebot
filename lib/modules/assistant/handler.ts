import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage, ScheduledJob } from "../types";
import {
  parseTodoIntent,
  addTodos,
  listTodos,
  completeTodos,
  deleteTodos,
  rescheduleTodo,
  clearDone,
  planLink,
} from "./todo";
import { handleMorningBriefJob } from "./morning-brief";

/**
 * Assistant: Todo & Morning Brief (module_key: assistant_productivity)
 * Per SYSTEM-DESIGN.md §4.2 (ModuleHandler interface) and SPEC.md §6.3.
 *
 * Todo Manager is fully implemented (real CRUD against upl_todos, target-scoped).
 * UX: a plain text message IS a todo (1 line = 1 task) — no "เพิ่ม" prefix needed. A small
 * set of command words (ค้าง / ลบ N / เลื่อน / วางแผน / ลบทั้งหมด / ล้างที่เสร็จ) are
 * recognised first; everything else is added as a task. This module is LAST in
 * ROUTER_PRIORITY so broadcast trigger keywords still win before text becomes a todo.
 * Calendar Sync & News Digest remain future work (Google OAuth) and are no longer keyword-
 * intercepted — those words simply become todos until the real integrations ship.
 */

export const AssistantModule: ModuleHandler = {
  key: "assistant_productivity",

  matchesIntent(event: LineEvent, _config: ModuleConfig): boolean {
    // Any non-empty text message is handled by the Todo manager (plain text = add a task).
    if (event.type !== "message" || event.message?.type !== "text") return false;
    return !!event.message.text?.trim();
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const text = event.message?.text ?? "";

    const todoIntent = parseTodoIntent(text);
    if (!todoIntent) return [];

    switch (todoIntent.action) {
      case "add":
        return addTodos(ctx.targetId, todoIntent.items);
      case "list":
        return listTodos(ctx.targetId);
      case "done":
        return completeTodos(ctx.targetId, todoIntent.indexes);
      case "delete":
        return deleteTodos(ctx.targetId, { indexes: todoIntent.indexes });
      case "delete_all":
        return deleteTodos(ctx.targetId, { all: true });
      case "reschedule":
        return rescheduleTodo(ctx.targetId, todoIntent.index, todoIntent.whenText);
      case "clear_done":
        return clearDone(ctx.targetId);
      case "plan":
        return planLink(ctx.targetId);
    }
  },

  async handleScheduledJob(job: ScheduledJob, ctx: TenantContext): Promise<OutboundMessage[]> {
    if (job.jobType === "morning_brief") {
      return handleMorningBriefJob(job, ctx);
    }
    return [];
  },
};
