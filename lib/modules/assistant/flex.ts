import type { OutboundMessage, QuickReplyItem } from "../types";
import { formatThaiDueAt } from "./datetime";

/**
 * Flex + plain-text builders for the Todo Manager list.
 *
 * buildTodoListFlex(todos, opts) → a polished numbered Flex bubble (LINE Flex spec:
 * bubble → box(vertical) → text/box/separator), plus a Quick Reply attached to the
 * returned message. `todos` are ALREADY numbered/ordered by the caller (todo.ts) — the
 * `n` field is the visible 1..N number that done/delete/reschedule commands reference.
 *
 * buildTodoListText(todos, opts) → the plain-text fallback used for confirmations / any
 * surface where Flex is not desired.
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

// TONPALEARN-ish palette: charcoal text, muted secondary, green accent for done, amber for due.
const COLOR_TEXT = "#1F2933";
const COLOR_MUTED = "#7B8794";
const COLOR_DONE = "#9AA5B1";
const COLOR_ACCENT = "#0E7C66"; // green — header + done check
const COLOR_DUE = "#B45309"; // amber — due date/time
const COLOR_NUM_BG = "#E6F4F1"; // pale green chip behind the number
const COLOR_SEP = "#E4E7EB";

const DEFAULT_TITLE = "📋 รายการงาน";

/** The three fixed Quick Reply buttons required for the list reply. */
export function todoQuickReply(): { items: QuickReplyItem[] } {
  return {
    items: [
      { type: "action", action: { type: "message", label: "📋 งานวันนี้", text: "งานวันนี้" } },
      { type: "action", action: { type: "message", label: "🗓️ วางแผน", text: "วางแผน" } },
      { type: "action", action: { type: "message", label: "🧹 ล้างที่เสร็จ", text: "ล้างที่เสร็จ" } },
    ],
  };
}

/** One task row: number chip + task text (+ due line when present). */
function todoRow(item: TodoListItem, now: Date): Record<string, unknown> {
  const isDone = item.done;

  const textContents: Record<string, unknown>[] = [
    {
      type: "text",
      text: isDone ? `✅ ${item.content}` : item.content,
      size: "sm",
      color: isDone ? COLOR_DONE : COLOR_TEXT,
      weight: isDone ? "regular" : "bold",
      wrap: true,
      // strike-through styling isn't a Flex text property; the ✅ + muted grey conveys "done".
      decoration: isDone ? "line-through" : "none",
    },
  ];

  if (item.dueAt) {
    textContents.push({
      type: "text",
      text: `🗓️ ${formatThaiDueAt(item.dueAt, now)}`,
      size: "xs",
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
      // Number chip
      {
        type: "box",
        layout: "vertical",
        width: "28px",
        height: "28px",
        cornerRadius: "14px",
        backgroundColor: isDone ? COLOR_SEP : COLOR_NUM_BG,
        justifyContent: "center",
        contents: [
          {
            type: "text",
            text: String(item.n),
            size: "sm",
            weight: "bold",
            align: "center",
            color: isDone ? COLOR_MUTED : COLOR_ACCENT,
          },
        ],
      },
      // Task text block (grows to fill)
      {
        type: "box",
        layout: "vertical",
        flex: 1,
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
    if (i > 0) {
      bodyContents.push({ type: "separator", margin: "md", color: COLOR_SEP });
    }
    bodyContents.push(todoRow(item, now));
  });

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      paddingBottom: "12px",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "lg",
          color: COLOR_ACCENT,
        },
        {
          type: "text",
          text: `ค้าง ${openCount}/ทั้งหมด ${total}`,
          size: "xs",
          color: COLOR_MUTED,
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      paddingTop: "8px",
      spacing: "none",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: 'เสร็จ [เลข] · ลบ [เลข] · เลื่อน [เลข] [เวลา]',
          size: "xxs",
          color: COLOR_MUTED,
          wrap: true,
          align: "center",
        },
      ],
    },
    styles: {
      header: { backgroundColor: "#FFFFFF" },
      footer: { backgroundColor: "#FAFBFC" },
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
