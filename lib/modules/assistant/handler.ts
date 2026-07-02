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
 * UX: adding a task needs the "เพิ่ม" prefix ("เพิ่ม <งาน>", multi-line = 1 line/task). A set
 * of command words (ค้าง / ลบ N / เลื่อน / วางแผน / ลบทั้งหมด / ล้างที่เสร็จ) are also
 * recognised. Any other plain text is NOT a todo, so ordinary chat is never turned into a
 * task. Calendar Sync & News Digest remain future work (Google OAuth).
 */

export const AssistantModule: ModuleHandler = {
  key: "assistant_productivity",

  matchesIntent(event: LineEvent, _config: ModuleConfig): boolean {
    // Handled only when the text is a todo command ("เพิ่ม …", ค้าง, ลบ N, เลื่อน, วางแผน, …).
    if (event.type !== "message" || event.message?.type !== "text") return false;
    return parseTodoIntent(event.message.text ?? "") !== null;
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
