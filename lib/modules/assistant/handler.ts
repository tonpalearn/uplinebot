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
import { handleCalendarIntent } from "./calendar";
import { handleNewsIntent } from "./news";
import { handleMorningBriefJob } from "./morning-brief";

/**
 * Assistant: Todo, Calendar & Morning Brief (module_key: assistant_productivity)
 * Per SYSTEM-DESIGN.md §4.2 (ModuleHandler interface) and SPEC.md §6.3.
 *
 * Todo Manager is fully implemented (real CRUD against upl_todos, target-scoped).
 * Calendar Sync, News Digest, and Morning Brief are out of scope for this pass
 * (require real Google OAuth) — they are wired into matchesIntent/handleEvent so the
 * interface is complete, but each returns a clear Thai "not yet connected" stub message
 * (see ./calendar.ts, ./news.ts, ./morning-brief.ts).
 */

const CALENDAR_KEYWORDS = /^(นัดหมาย|ปฏิทิน)/i;
const NEWS_KEYWORDS = /^(ข่าว|สรุปข่าว)/i;

export const AssistantModule: ModuleHandler = {
  key: "assistant_productivity",

  matchesIntent(event: LineEvent, _config: ModuleConfig): boolean {
    if (event.type !== "message" || event.message?.type !== "text") return false;
    const text = event.message.text ?? "";
    if (!text.trim()) return false;

    if (parseTodoIntent(text)) return true;
    if (CALENDAR_KEYWORDS.test(text.trim())) return true;
    if (NEWS_KEYWORDS.test(text.trim())) return true;

    return false;
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    const text = event.message?.text ?? "";
    const trimmed = text.trim();

    const todoIntent = parseTodoIntent(text);
    if (todoIntent) {
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
    }

    if (CALENDAR_KEYWORDS.test(trimmed)) {
      return handleCalendarIntent();
    }

    if (NEWS_KEYWORDS.test(trimmed)) {
      return handleNewsIntent();
    }

    return [];
  },

  async handleScheduledJob(job: ScheduledJob, ctx: TenantContext): Promise<OutboundMessage[]> {
    if (job.jobType === "morning_brief") {
      return handleMorningBriefJob(job, ctx);
    }
    return [];
  },
};
