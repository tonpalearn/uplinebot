import type { OutboundMessage, QuickReplyItem } from "../types";
import { formatThaiDueAt } from "./datetime";
import {
  FS,
  NEUTRAL,
  TODO_ACCENT,
  gradientHeader,
  headerStyle,
  footerStyle,
  numberChip,
  softSep,
} from "../flex-ui";

/**
 * Flex + plain-text builders for the Todo Manager list.
 *
 * The card wears the shared design system (lib/modules/flex-ui.ts) in the TODO accent —
 * a RED gradient header + rose number chips — so a task list is instantly distinguishable
 * from the GREEN money card. Typography comes from the shared FS scale (bigger, readable).
 *
 * buildTodoListFlex(todos, opts) → a polished numbered Flex bubble (bubble → header(gradient)
 * → body(rows) → footer(hint)), plus a Quick Reply. `todos` are ALREADY numbered/ordered by
 * the caller (todo.ts); the `n` field is the visible 1..N number that done/delete/reschedule
 * commands reference.
 *
 * buildTodoListText(todos, opts) → plain-text fallback for confirmations / non-Flex surfaces.
 */

export interface TodoListItem {
  n: number; // visible number (1..N)
  content: string;
  done: boolean;
  dueAt: Date | null;
}

export interface BuildListOpts {
  /** Reference "now" for relative date formatting (Asia/Bangkok). */
  now: Date;
  /** Optional heading override; defaults to "📋 รายการงาน". */
  title?: string;
}

const COLOR_DONE = "#9AA5B1"; // muted grey for completed rows
const COLOR_DUE = "#B45309"; // amber for the due date/time line

const DEFAULT_TITLE = "📋 รายการงาน";

/** The three fixed Quick Reply buttons required for the list reply. */
export function todoQuickReply(): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "📋 งานค้าง", text: "ค้าง" } },
      { type: "action", action: { type: "message", label: "🗓️ วางแผน", text: "วางแผน" } },
      { type: "action", action: { type: "message", label: "🧹 ล้างที่เสร็จ", text: "ล้างที่เสร็จ" } },
    ],
  };
}

/** One task row: rose number chip + task text (+ due line when present). */
function todoRow(item: TodoListItem, now: Date): Record<string, unknown> {
  const isDone = item.done;

  const textContents: Record<string, unknown>[] = [
    {
      type: "text",
      text: isDone ? `✅ ${item.content}` : item.content,
      size: FS.body,
      color: isDone ? COLOR_DONE : NEUTRAL.text,
      weight: isDone ? "regular" : "bold",
      wrap: true,
      // Flex has no strike-through text property; the ✅ + muted grey + line-through convey "done".
      decoration: isDone ? "line-through" : "none",
    },
  ];

  if (item.dueAt) {
    textContents.push({
      type: "text",
      text: `🗓️ ${formatThaiDueAt(item.dueAt, now)}`,
      size: FS.meta,
      color: COLOR_DUE,
      wrap: true,
      margin: "xs",
    });
  }

  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    margin: "md",
    contents: [
      numberChip(item.n, TODO_ACCENT, isDone),
      {
        type: "box",
        layout: "vertical",
        flex: 1,
        justifyContent: "center",
        contents: textContents,
      },
    ],
  };
}

/**
 * Build the Flex list message. Assumes `todos` is non-empty AND already ordered/numbered;
 * for the empty case the caller (todo.ts) sends a plain-text prompt instead.
 */
export function buildTodoListFlex(todos: TodoListItem[], opts: BuildListOpts): OutboundMessage {
  const { now } = opts;
  const title = opts.title ?? DEFAULT_TITLE;
  const total = todos.length;
  const openCount = todos.filter((t) => !t.done).length;

  const bodyContents: Record<string, unknown>[] = [];
  todos.forEach((item, i) => {
    if (i > 0) bodyContents.push(softSep("md"));
    bodyContents.push(todoRow(item, now));
  });

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: gradientHeader({
      accent: TODO_ACCENT,
      title,
      subtitle: `ค้าง ${openCount}/ทั้งหมด ${total}`,
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
      contents: [
        {
          type: "text",
          text: "เสร็จ [เลข] · ลบ [เลข] · เลื่อน [เลข] [เวลา]",
          size: FS.caption,
          color: NEUTRAL.muted,
          wrap: true,
          align: "center",
        },
      ],
    },
    styles: {
      header: headerStyle(TODO_ACCENT),
      footer: footerStyle(),
    },
  };

  const altText =
    total === 0
      ? "รายการงาน (ว่าง)"
      : `รายการงาน — ค้าง ${openCount}/${total}: ${todos
          .slice(0, 3)
          .map((t) => `${t.n}. ${t.content}`)
          .join(", ")}${total > 3 ? " …" : ""}`;

  return {
    type: "flex",
    altText,
    contents: bubble,
    quickReply: todoQuickReply(),
  };
}

/**
 * Plain-text fallback list builder — used for confirmations (add/done/delete summaries)
 * and any non-Flex surface. Mirrors the numbered format the Flex card shows.
 */
export function buildTodoListText(todos: TodoListItem[], opts: BuildListOpts): string {
  const { now } = opts;
  if (todos.length === 0) {
    return "ยังไม่มีงานในรายการ พิมพ์ \"เพิ่ม [ชื่องาน]\" เพื่อเริ่มได้เลย";
  }
  const openCount = todos.filter((t) => !t.done).length;
  const lines = todos.map((t) => {
    const box = t.done ? "[x]" : "[ ]";
    const due = t.dueAt ? ` (🗓️ ${formatThaiDueAt(t.dueAt, now)})` : "";
    return `${t.n}. ${box} ${t.content}${due}`;
  });
  return `รายการงาน (ค้าง ${openCount}/${todos.length}):\n${lines.join("\n")}`;
}
