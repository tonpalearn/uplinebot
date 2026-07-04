"use client";

// Customer calendar planner — reachable at /plan/<token> where <token> is upl_targets.plan_token
// (the bot sends this link via "วางแผน"). The token IS the auth: every request to
// /api/plan/<token> revalidates it server-side and scopes reads/writes to that one LINE
// chat/group's tasks. This page never sees a targetId; it only knows its token.
//
// Layout: a dark-glass month calendar (Thai labels, Buddhist year) whose day cells badge
// tasks due that day, beside a full task list (dated groups + an "undated" section) with
// per-task toggle / edit / reschedule / delete / reorder, plus an add form.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  T,
  FONT,
  MONO,
  type Todo,
  type BkkYmd,
  THAI_MONTHS_FULL,
  THAI_WEEKDAYS_SHORT,
  LEAD_PRESETS,
  TASK_LEAD_PRESETS,
  bkkYmdOf,
  bkkDow,
  daysInMonth,
  ymdKey,
  dueDayKey,
  toDatetimeLocalValue,
  datetimeLocalToIso,
  dayAtDefaultTime,
  fmtDueRelative,
  fmtTime,
  isOverdue,
} from "./planner-lib";

// ── page ────────────────────────────────────────────────────────────────────────────────
export default function PlanPage({ params }: { params: { token: string } }) {
  const token = params.token;
  const apiBase = `/api/plan/${encodeURIComponent(token)}`;

  const [todos, setTodos] = useState<Todo[]>([]);
  // The TARGET's default reminder lead (minutes before due; 0 = at due time). Tasks without
  // their own remind_before_minutes override fall back to this.
  const [leadMinutes, setLeadMinutes] = useState<number>(0);
  const [status, setStatus] = useState<"loading" | "ok" | "invalid" | "error">("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());

  // Calendar month cursor (Bangkok wall-clock), initialised to the current Bangkok month.
  const todayYmd = useMemo(() => bkkYmdOf(now), [now]);
  const [cursor, setCursor] = useState<{ y: number; m: number }>(() => {
    const t = bkkYmdOf(new Date());
    return { y: t.y, m: t.m };
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // ── data ──────────────────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const res = await fetch(apiBase, { cache: "no-store" });
      if (res.status === 401) {
        setStatus("invalid");
        return;
      }
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setStatus("error");
        setErrMsg(json?.reason || `HTTP ${res.status}`);
        return;
      }
      setTodos((json.todos || []) as Todo[]);
      if (typeof json.reminder_lead_minutes === "number") {
        setLeadMinutes(json.reminder_lead_minutes);
      }
      setStatus("ok");
      setErrMsg(null);
    } catch (e) {
      setStatus("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  }, [apiBase]);

  useEffect(() => {
    load();
    // Refresh "now" every minute so relative labels + overdue styling stay honest.
    const iv = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(iv);
  }, [load]);

  // Optimistic helpers — mutate local state, then reconcile with the server row it returns.
  const applyPatch = useCallback(
    async (
      id: string,
      patch: Partial<Pick<Todo, "content" | "due_at" | "done" | "sort_order" | "remind_before_minutes">>
    ) => {
      setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      try {
        const res = await fetch(apiBase, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, ...patch }),
        });
        const json = await res.json();
        if (res.ok && json?.ok && json.todo) {
          const server = json.todo as Todo;
          setTodos((prev) => prev.map((t) => (t.id === id ? server : t)));
        } else if (!res.ok) {
          await load(); // revert to server truth on failure (e.g. 404)
        }
      } catch {
        await load();
      }
    },
    [apiBase, load]
  );

  // Set the TARGET default lead — PATCH { reminder_lead_minutes } (no id). Optimistic:
  // flip local state now, revert to the previous value if the server rejects it.
  const setLead = useCallback(
    async (next: number) => {
      const prev = leadMinutes;
      if (next === prev) return;
      setLeadMinutes(next);
      try {
        const res = await fetch(apiBase, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reminder_lead_minutes: next }),
        });
        const json = await res.json();
        if (res.ok && json?.ok && typeof json.reminder_lead_minutes === "number") {
          setLeadMinutes(json.reminder_lead_minutes); // adopt the clamped server value
        } else {
          setLeadMinutes(prev); // revert on failure
        }
      } catch {
        setLeadMinutes(prev);
      }
    },
    [apiBase, leadMinutes]
  );

  const addTodo = useCallback(
    async (content: string, dueIso: string | null) => {
      const body = { content, due_at: dueIso };
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (res.ok && json?.ok && json.todo) {
        setTodos((prev) => [...prev, json.todo as Todo]);
        return true;
      }
      setErrMsg(json?.reason || "เพิ่มงานไม่สำเร็จ");
      return false;
    },
    [apiBase]
  );

  const removeTodo = useCallback(
    async (id: string) => {
      const prevList = todos;
      setTodos((prev) => prev.filter((t) => t.id !== id));
      try {
        const res = await fetch(`${apiBase}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) setTodos(prevList);
      } catch {
        setTodos(prevList);
      }
    },
    [apiBase, todos]
  );

  // Move a task up/down among the *dated-or-not combined* ordered list by rewriting the
  // sort_order of the two swapped rows (dense integers based on current positions).
  const reorder = useCallback(
    async (id: string, dir: -1 | 1) => {
      const ordered = todos;
      const idx = ordered.findIndex((t) => t.id === id);
      const swapIdx = idx + dir;
      if (idx < 0 || swapIdx < 0 || swapIdx >= ordered.length) return;
      const a = ordered[idx];
      const b = ordered[swapIdx];
      // Assign explicit sort_orders derived from index so the swap is unambiguous.
      const aOrder = swapIdx;
      const bOrder = idx;
      setTodos((prev) => {
        const next = prev.slice();
        const ai = next.findIndex((t) => t.id === a.id);
        const bi = next.findIndex((t) => t.id === b.id);
        if (ai >= 0) next[ai] = { ...next[ai], sort_order: aOrder };
        if (bi >= 0) next[bi] = { ...next[bi], sort_order: bOrder };
        next.sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
        return next;
      });
      await Promise.all([
        applyPatch(a.id, { sort_order: aOrder }),
        applyPatch(b.id, { sort_order: bOrder }),
      ]);
    },
    [todos, applyPatch]
  );

  // ── derived: bucket tasks by Bangkok due-day; split dated vs undated ───────────────────
  const byDay = useMemo(() => {
    const map = new Map<string, Todo[]>();
    for (const t of todos) {
      const k = dueDayKey(t.due_at);
      if (!k) continue;
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    return map;
  }, [todos]);

  const undated = useMemo(() => todos.filter((t) => !t.due_at), [todos]);
  const openCount = useMemo(() => todos.filter((t) => !t.done).length, [todos]);

  // ── render states ─────────────────────────────────────────────────────────────────────
  return (
    <>
      <FontLink />
      <GlobalStyle />
      <main className="plan-scope" style={sx.page}>
        <div style={sx.shell}>
          <Header openCount={openCount} loading={status === "loading"} onRefresh={load} />

          {status === "invalid" && <InvalidState />}
          {status === "error" && (
            <Banner tone="danger">
              โหลดข้อมูลไม่สำเร็จ{errMsg ? `: ${errMsg}` : ""} — ลองรีเฟรชอีกครั้ง
            </Banner>
          )}

          {status !== "invalid" && (
            <>
              <AddBar
                defaultDay={selectedKey}
                onAdd={addTodo}
                disabled={status === "loading"}
              />

              <ReminderSetting
                lead={leadMinutes}
                onChange={setLead}
                disabled={status === "loading"}
              />

              <div className="plan-grid2" style={sx.grid2}>
                <Calendar
                  cursor={cursor}
                  setCursor={setCursor}
                  todayKey={ymdKey(todayYmd)}
                  byDay={byDay}
                  selectedKey={selectedKey}
                  onSelectDay={(k) => setSelectedKey((cur) => (cur === k ? null : k))}
                  now={now}
                />
                <TaskList
                  todos={todos}
                  byDay={byDay}
                  undated={undated}
                  selectedKey={selectedKey}
                  clearSelected={() => setSelectedKey(null)}
                  now={now}
                  onToggle={(t) => applyPatch(t.id, { done: !t.done })}
                  onEdit={(t, content) => applyPatch(t.id, { content })}
                  onReschedule={(t, iso) => applyPatch(t.id, { due_at: iso })}
                  onRemind={(t, mins) => applyPatch(t.id, { remind_before_minutes: mins })}
                  onDelete={(t) => removeTodo(t.id)}
                  onReorder={reorder}
                  loading={status === "loading"}
                />
              </div>
            </>
          )}

          <footer style={sx.footer}>
            UP Line · ปฏิทินงานของแชทนี้ — ลิงก์นี้เฉพาะกลุ่ม/แชทนี้เท่านั้น ไม่ต้องล็อกอิน
          </footer>
        </div>
      </main>
    </>
  );
}

// ── header ──────────────────────────────────────────────────────────────────────────────
function Header({
  openCount,
  loading,
  onRefresh,
}: {
  openCount: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="plan-hero" style={sx.hero}>
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={sx.eyebrow}>ปฏิทินงาน · My Planner</div>
        <h1 style={sx.h1}>
          วางแผนงานของ<span style={sx.h1grad}>แชทนี้</span>
        </h1>
        <p style={sx.heroSub}>
          จัดลำดับงาน ตั้งวันเวลา และดูภาพรวมทั้งเดือน — บอทจะเตือนเมื่อถึงกำหนดในไลน์
          {openCount > 0 ? ` · เหลือ ${openCount} งานที่ยังไม่เสร็จ` : " · ไม่มีงานค้าง"}
        </p>
      </div>
      <button onClick={onRefresh} disabled={loading} style={sx.refreshBtn}>
        {loading ? "กำลังโหลด…" : "↻ รีเฟรช"}
      </button>
    </div>
  );
}

// ── add bar ─────────────────────────────────────────────────────────────────────────────
function AddBar({
  defaultDay,
  onAdd,
  disabled,
}: {
  defaultDay: string | null;
  onAdd: (content: string, dueIso: string | null) => Promise<boolean>;
  disabled?: boolean;
}) {
  const [content, setContent] = useState("");
  const [dtLocal, setDtLocal] = useState("");
  const [busy, setBusy] = useState(false);

  // When a calendar day is selected, pre-fill the date picker to that day @ 09:00 (once).
  const lastDay = useRef<string | null>(null);
  useEffect(() => {
    if (defaultDay && defaultDay !== lastDay.current) {
      const [y, m, d] = defaultDay.split("-").map(Number);
      setDtLocal(dayAtDefaultTime({ y, m, d }));
    }
    lastDay.current = defaultDay;
  }, [defaultDay]);

  const submit = async () => {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onAdd(text, datetimeLocalToIso(dtLocal));
    setBusy(false);
    if (ok) {
      setContent("");
      // keep the chosen day/time so adding several tasks to one day is quick
    }
  };

  return (
    <div style={sx.addWrap}>
      <span style={sx.addPlus}>➕</span>
      <input
        style={sx.addInput}
        value={content}
        placeholder="เพิ่มงาน เช่น โทรหาลูกค้า…"
        disabled={disabled || busy}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <input
        type="datetime-local"
        style={sx.addDate}
        value={dtLocal}
        disabled={disabled || busy}
        onChange={(e) => setDtLocal(e.target.value)}
        title="วัน-เวลา (ไม่บังคับ)"
      />
      {dtLocal && (
        <button
          style={sx.addClearDate}
          onClick={() => setDtLocal("")}
          title="ล้างวันเวลา (เป็นงานไม่มีกำหนด)"
        >
          ✕ วันเวลา
        </button>
      )}
      <button style={sx.addBtn} onClick={submit} disabled={disabled || busy || !content.trim()}>
        {busy ? "…" : "เพิ่มงาน"}
      </button>
    </div>
  );
}

// ── reminder default setting ────────────────────────────────────────────────────────────
// Compact "⏰ การเตือน" panel: picks the TARGET's default lead (how long before a task's due
// time the bot pings LINE). Segmented presets mirror LEAD_PRESETS; the active one is
// highlighted. Persist happens in the parent's setLead (optimistic PATCH); we just flash a
// tiny "บันทึกแล้ว" once the selected value settles to what the caller reports back.
function ReminderSetting({
  lead,
  onChange,
  disabled,
}: {
  lead: number;
  onChange: (mins: number) => void;
  disabled?: boolean;
}) {
  // Show "บันทึกแล้ว" briefly after a change lands. We compare against the last value we
  // *sent* so the flash only appears for user-driven edits, not the initial GET hydration.
  const [saved, setSaved] = useState(false);
  const sentRef = useRef<number | null>(null);
  useEffect(() => {
    if (sentRef.current === null || sentRef.current !== lead) return;
    setSaved(true);
    const t = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(t);
  }, [lead]);

  const pick = (value: number) => {
    if (disabled || value === lead) return;
    sentRef.current = value;
    onChange(value);
  };

  return (
    <div style={sx.remindWrap}>
      <div style={sx.remindHead}>
        <span style={sx.remindTitle}>⏰ เตือนก่อนถึงเวลา</span>
        {saved && <span style={sx.remindSaved}>✓ บันทึกแล้ว</span>}
      </div>
      <div style={sx.segRow}>
        {LEAD_PRESETS.map((p) => {
          const active = p.value === lead;
          return (
            <button
              key={p.value}
              onClick={() => pick(p.value)}
              disabled={disabled}
              style={{
                ...sx.segBtn,
                ...(active ? sx.segBtnOn : null),
                cursor: disabled ? "default" : "pointer",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <p style={sx.remindHelp}>
        งานที่ไม่ได้ตั้งเฉพาะจะเตือนก่อนถึงเวลาตามนี้ · ตั้งเฉพาะรายงานได้ในแต่ละงาน
      </p>
    </div>
  );
}

// ── calendar ────────────────────────────────────────────────────────────────────────────
function Calendar({
  cursor,
  setCursor,
  todayKey,
  byDay,
  selectedKey,
  onSelectDay,
  now,
}: {
  cursor: { y: number; m: number };
  setCursor: (c: { y: number; m: number }) => void;
  todayKey: string;
  byDay: Map<string, Todo[]>;
  selectedKey: string | null;
  onSelectDay: (key: string) => void;
  now: Date;
}) {
  const { y, m } = cursor;
  const firstDow = bkkDow({ y, m, d: 1 }); // 0=Sun
  const total = daysInMonth(y, m);

  // Build the 6-week grid: leading blanks for the first weekday offset, then 1..total.
  const cells: Array<number | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const go = (delta: number) => {
    let nm = m + delta;
    let ny = y;
    if (nm < 1) {
      nm = 12;
      ny -= 1;
    } else if (nm > 12) {
      nm = 1;
      ny += 1;
    }
    setCursor({ y: ny, m: nm });
  };

  return (
    <section style={sx.calCard}>
      <div style={sx.calHead}>
        <button style={sx.calNav} onClick={() => go(-1)} aria-label="เดือนก่อนหน้า">
          ‹
        </button>
        <div style={sx.calTitle}>
          {THAI_MONTHS_FULL[m - 1]} <span style={{ color: T.muted }}>{y + 543}</span>
        </div>
        <button style={sx.calNav} onClick={() => go(1)} aria-label="เดือนถัดไป">
          ›
        </button>
      </div>

      <div className="plan-dow" style={sx.dow}>
        {THAI_WEEKDAYS_SHORT.map((w, i) => (
          <div
            key={w}
            style={{
              ...sx.dowCell,
              color: i === 0 ? T.danger : i === 6 ? T.blue : T.dim,
            }}
          >
            {w}
          </div>
        ))}
      </div>

      <div className="plan-cal-grid" style={sx.calGrid}>
        {cells.map((d, i) => {
          if (d === null) return <div key={`b${i}`} style={sx.emptyCell} />;
          const key = ymdKey({ y, m, d });
          const tasks = byDay.get(key) || [];
          const open = tasks.filter((t) => !t.done);
          const isToday = key === todayKey;
          const isSel = key === selectedKey;
          const hasOverdue = open.some((t) => isOverdue(t.due_at, now));
          return (
            <button
              key={key}
              className="plan-day-cell"
              onClick={() => onSelectDay(key)}
              style={{
                ...sx.dayCell,
                borderColor: isSel ? T.blue : isToday ? T.border2 : "transparent",
                background: isSel
                  ? "rgba(77,163,255,.14)"
                  : isToday
                  ? "rgba(77,163,255,.05)"
                  : tasks.length
                  ? T.panel
                  : "transparent",
              }}
            >
              <span
                style={{
                  ...sx.dayNum,
                  color: isToday ? T.blue : T.text,
                  fontWeight: isToday ? 700 : 500,
                }}
              >
                {d}
              </span>
              {tasks.length > 0 && (
                <span style={sx.dayDots}>
                  {open.length > 0 && (
                    <span
                      style={{
                        ...sx.badge,
                        background: hasOverdue ? "rgba(255,107,125,.18)" : "rgba(55,226,176,.16)",
                        color: hasOverdue ? T.danger : T.green,
                        borderColor: hasOverdue ? "rgba(255,107,125,.4)" : "rgba(55,226,176,.35)",
                      }}
                    >
                      {open.length}
                    </span>
                  )}
                  {open.length === 0 && tasks.length > 0 && (
                    <span style={{ ...sx.badge, ...sx.badgeDone }}>✓</span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={sx.legend}>
        <span style={sx.legendItem}>
          <span style={{ ...sx.dot, background: T.green }} /> ยังไม่เสร็จ
        </span>
        <span style={sx.legendItem}>
          <span style={{ ...sx.dot, background: T.danger }} /> เลยกำหนด
        </span>
        <span style={sx.legendItem}>
          <span style={{ ...sx.dot, background: T.dim }} /> เสร็จหมดแล้ว
        </span>
      </div>
    </section>
  );
}

// ── task list ───────────────────────────────────────────────────────────────────────────
function TaskList({
  todos,
  byDay,
  undated,
  selectedKey,
  clearSelected,
  now,
  onToggle,
  onEdit,
  onReschedule,
  onRemind,
  onDelete,
  onReorder,
  loading,
}: {
  todos: Todo[];
  byDay: Map<string, Todo[]>;
  undated: Todo[];
  selectedKey: string | null;
  clearSelected: () => void;
  now: Date;
  onToggle: (t: Todo) => void;
  onEdit: (t: Todo, content: string) => void;
  onReschedule: (t: Todo, iso: string | null) => void;
  onRemind: (t: Todo, mins: number | null) => void;
  onDelete: (t: Todo) => void;
  onReorder: (id: string, dir: -1 | 1) => void;
  loading: boolean;
}) {
  // A running 1..N number across the full ordered list, so numbers match the chat list.
  const numberOf = useMemo(() => {
    const map = new Map<string, number>();
    todos.forEach((t, i) => map.set(t.id, i + 1));
    return map;
  }, [todos]);

  // When a day is selected, focus the list on that day.
  if (selectedKey) {
    const dayTasks = byDay.get(selectedKey) || [];
    const [yy, mm, dd] = selectedKey.split("-").map(Number);
    return (
      <section style={sx.listCard}>
        <div style={sx.listHead}>
          <div style={sx.listTitle}>
            งานวันที่ {dd}/{mm}/{yy + 543}
            <span style={sx.listCount}>{dayTasks.length}</span>
          </div>
          <button style={sx.chipBtn} onClick={clearSelected}>
            ดูทั้งหมด
          </button>
        </div>
        {dayTasks.length === 0 ? (
          <Empty text="วันนี้ยังไม่มีงาน — พิมพ์ด้านบนแล้วกดเพิ่มงานได้เลย" />
        ) : (
          <div style={sx.rows}>
            {dayTasks.map((t) => (
              <TaskRow
                key={t.id}
                todo={t}
                n={numberOf.get(t.id) ?? 0}
                now={now}
                canUp={false}
                canDown={false}
                onToggle={onToggle}
                onEdit={onEdit}
                onReschedule={onReschedule}
                onRemind={onRemind}
                onDelete={onDelete}
                onReorder={onReorder}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  // Full list: dated groups (sorted by day), then an undated section.
  const dayKeys = [...byDay.keys()].sort();

  return (
    <section style={sx.listCard}>
      <div style={sx.listHead}>
        <div style={sx.listTitle}>
          งานทั้งหมด
          <span style={sx.listCount}>{todos.length}</span>
        </div>
      </div>

      {todos.length === 0 && !loading && (
        <Empty text="ยังไม่มีงาน — เพิ่มงานแรกจากช่องด้านบน แล้วมันจะมาโผล่บนปฏิทิน" />
      )}

      <div style={sx.rows}>
        {dayKeys.map((k) => {
          const [yy, mm, dd] = k.split("-").map(Number);
          const isToday = k === ymdKey(bkkYmdOf(now));
          const items = byDay.get(k) || [];
          return (
            <div key={k}>
              <div style={sx.groupLabel}>
                <span style={{ color: isToday ? T.blue : T.muted }}>
                  {isToday ? "วันนี้ · " : ""}
                  {dd}/{mm}/{yy + 543}
                </span>
                <span style={sx.groupCount}>{items.length}</span>
              </div>
              {items.map((t) => (
                <TaskRow
                  key={t.id}
                  todo={t}
                  n={numberOf.get(t.id) ?? 0}
                  now={now}
                  canUp={(numberOf.get(t.id) ?? 1) > 1}
                  canDown={(numberOf.get(t.id) ?? todos.length) < todos.length}
                  onToggle={onToggle}
                  onEdit={onEdit}
                  onReschedule={onReschedule}
                  onRemind={onRemind}
                  onDelete={onDelete}
                  onReorder={onReorder}
                />
              ))}
            </div>
          );
        })}

        {undated.length > 0 && (
          <div>
            <div style={sx.groupLabel}>
              <span style={{ color: T.dim }}>ไม่มีกำหนด</span>
              <span style={sx.groupCount}>{undated.length}</span>
            </div>
            {undated.map((t) => (
              <TaskRow
                key={t.id}
                todo={t}
                n={numberOf.get(t.id) ?? 0}
                now={now}
                canUp={(numberOf.get(t.id) ?? 1) > 1}
                canDown={(numberOf.get(t.id) ?? todos.length) < todos.length}
                onToggle={onToggle}
                onEdit={onEdit}
                onReschedule={onReschedule}
                onRemind={onRemind}
                onDelete={onDelete}
                onReorder={onReorder}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── one task row (view + inline edit + reschedule) ──────────────────────────────────────
function TaskRow({
  todo,
  n,
  now,
  canUp,
  canDown,
  onToggle,
  onEdit,
  onReschedule,
  onRemind,
  onDelete,
  onReorder,
}: {
  todo: Todo;
  n: number;
  now: Date;
  canUp: boolean;
  canDown: boolean;
  onToggle: (t: Todo) => void;
  onEdit: (t: Todo, content: string) => void;
  onReschedule: (t: Todo, iso: string | null) => void;
  onRemind: (t: Todo, mins: number | null) => void;
  onDelete: (t: Todo) => void;
  onReorder: (id: string, dir: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.content);
  const [picking, setPicking] = useState(false);
  const [dt, setDt] = useState<string>(() => toDatetimeLocalValue(todo.due_at));
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(todo.content);
  }, [todo.content, editing]);
  useEffect(() => {
    if (!picking) setDt(toDatetimeLocalValue(todo.due_at));
  }, [todo.due_at, picking]);

  const overdue = !todo.done && isOverdue(todo.due_at, now);

  const saveEdit = () => {
    const text = draft.trim();
    if (text && text !== todo.content) onEdit(todo, text);
    setEditing(false);
  };

  const saveDate = () => {
    onReschedule(todo, datetimeLocalToIso(dt));
    setPicking(false);
  };

  return (
    <div
      style={{
        ...sx.row,
        opacity: todo.done ? 0.62 : 1,
        borderColor: overdue ? "rgba(255,107,125,.35)" : T.border,
        background: overdue ? "rgba(255,107,125,.05)" : T.panel,
      }}
    >
      <button
        onClick={() => onToggle(todo)}
        style={{
          ...sx.check,
          background: todo.done ? T.green : "transparent",
          borderColor: todo.done ? T.green : T.border2,
          color: T.onAccent,
        }}
        aria-label={todo.done ? "ทำเป็นยังไม่เสร็จ" : "ทำเป็นเสร็จแล้ว"}
        title={todo.done ? "ทำเป็นยังไม่เสร็จ" : "ทำเป็นเสร็จแล้ว"}
      >
        {todo.done ? "✓" : ""}
      </button>

      <span style={sx.rowNum}>{n}</span>

      <div style={sx.rowMain}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") {
                setDraft(todo.content);
                setEditing(false);
              }
            }}
            style={sx.editInput}
          />
        ) : (
          <div
            style={{
              ...sx.rowText,
              textDecoration: todo.done ? "line-through" : "none",
              color: todo.done ? T.muted : T.text,
            }}
            onDoubleClick={() => setEditing(true)}
            title="ดับเบิลคลิกเพื่อแก้ไข"
          >
            {todo.content}
          </div>
        )}

        {picking ? (
          <div style={sx.pickRow}>
            <input
              type="datetime-local"
              value={dt}
              onChange={(e) => setDt(e.target.value)}
              style={sx.pickInput}
              autoFocus
            />
            <button style={sx.miniPrimary} onClick={saveDate}>
              บันทึก
            </button>
            <button
              style={sx.miniGhost}
              onClick={() => {
                onReschedule(todo, null);
                setPicking(false);
              }}
            >
              ล้างกำหนด
            </button>
            <button
              style={sx.miniGhost}
              onClick={() => {
                setDt(toDatetimeLocalValue(todo.due_at));
                setPicking(false);
              }}
            >
              ยกเลิก
            </button>
          </div>
        ) : (
          <button style={sx.dueChip} onClick={() => setPicking(true)}>
            {todo.due_at ? (
              <>
                🕒 {fmtDueRelative(todo.due_at, now)}
                {overdue && <span style={{ color: T.danger, fontWeight: 600 }}> · เลยกำหนด</span>}
              </>
            ) : (
              <span style={{ color: T.dim }}>＋ ตั้งวันเวลา</span>
            )}
          </button>
        )}

        {/* Per-task reminder-lead override — only meaningful once the task has a due time. */}
        {todo.due_at && !picking && (
          <label style={sx.remindPick}>
            <span style={sx.remindPickLabel}>🔔 เตือนก่อน</span>
            <select
              style={sx.remindSelect}
              value={todo.remind_before_minutes ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onRemind(todo, v === "" ? null : Number(v));
              }}
            >
              {TASK_LEAD_PRESETS.map((p) => (
                <option key={p.label} value={p.value ?? ""}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div style={sx.rowActions}>
        <div style={sx.reorderCol}>
          <button
            style={{ ...sx.arrowBtn, opacity: canUp ? 1 : 0.25, cursor: canUp ? "pointer" : "default" }}
            onClick={() => canUp && onReorder(todo.id, -1)}
            disabled={!canUp}
            aria-label="เลื่อนขึ้น"
            title="เลื่อนขึ้น"
          >
            ▲
          </button>
          <button
            style={{ ...sx.arrowBtn, opacity: canDown ? 1 : 0.25, cursor: canDown ? "pointer" : "default" }}
            onClick={() => canDown && onReorder(todo.id, 1)}
            disabled={!canDown}
            aria-label="เลื่อนลง"
            title="เลื่อนลง"
          >
            ▼
          </button>
        </div>
        {!editing && (
          <button style={sx.iconBtn} onClick={() => setEditing(true)} title="แก้ไขข้อความ">
            ✎
          </button>
        )}
        {confirmDel ? (
          <span style={sx.delConfirm}>
            <button style={sx.delYes} onClick={() => onDelete(todo)}>
              ลบ
            </button>
            <button style={sx.miniGhost} onClick={() => setConfirmDel(false)}>
              ไม่
            </button>
          </span>
        ) : (
          <button
            style={{ ...sx.iconBtn, color: T.danger }}
            onClick={() => setConfirmDel(true)}
            title="ลบงาน"
          >
            🗑
          </button>
        )}
      </div>
    </div>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────────────────
function Empty({ text }: { text: string }) {
  return <div style={sx.empty}>{text}</div>;
}

function Banner({ tone, children }: { tone: "danger" | "info"; children: React.ReactNode }) {
  const c = tone === "danger" ? T.danger : T.blue;
  return (
    <div
      style={{
        fontSize: 13.5,
        color: c,
        background: `${tone === "danger" ? "rgba(255,107,125,.08)" : "rgba(77,163,255,.08)"}`,
        border: `1px solid ${c}44`,
        borderRadius: 12,
        padding: "11px 14px",
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

function InvalidState() {
  return (
    <div style={sx.invalidCard}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>🔒</div>
      <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700 }}>ลิงก์นี้ใช้ไม่ได้</h2>
      <p style={{ margin: 0, color: T.muted, fontSize: 14, lineHeight: 1.6, maxWidth: 420 }}>
        ลิงก์ปฏิทินไม่ถูกต้องหรือหมดอายุแล้ว — พิมพ์ <b style={{ color: T.text }}>วางแผน</b> ในแชท LINE
        กับบอทอีกครั้ง เพื่อรับลิงก์ใหม่ของกลุ่ม/แชทนี้
      </p>
    </div>
  );
}

// Load IBM Plex Sans Thai + JetBrains Mono (guide.html uses the same families).
function FontLink() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
    </>
  );
}

// Page-scoped global CSS: body background gradient + input theming + custom scrollbars.
function GlobalStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        html,body{margin:0;padding:0;background:${T.bg};}
        *{box-sizing:border-box;}
        .plan-scope input[type="datetime-local"]{
          color-scheme:light dark;font-family:${FONT};
        }
        .plan-scope select{color-scheme:light dark;}
        .plan-scope input::placeholder{color:${T.dim};}
        .plan-scope ::-webkit-scrollbar{width:9px;height:9px;}
        .plan-scope ::-webkit-scrollbar-thumb{background:${T.border2};border-radius:8px;}
        .plan-scope ::-webkit-scrollbar-track{background:transparent;}
        .plan-day-cell:hover{filter:brightness(1.25);}
        /* ── responsive: collapse the 2-col planner → 1-col; tighten calendar on phones (LINE webview) ── */
        @media (max-width:820px){
          .plan-grid2{grid-template-columns:1fr !important;}
        }
        @media (max-width:560px){
          .plan-scope{padding:16px 12px 48px !important;}
          .plan-hero{padding:20px 18px !important;border-radius:18px !important;}
          .plan-hero h1{font-size:24px !important;}
          .plan-dow,.plan-cal-grid{gap:3px !important;}
          .plan-day-cell{min-height:46px !important;padding:5px !important;}
        }
      `,
      }}
    />
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────────────
const sx: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    fontFamily: FONT,
    color: T.text,
    background: `
      radial-gradient(1200px 700px at 85% -10%, rgba(77,163,255,.12), transparent 60%),
      radial-gradient(900px 600px at 0% 15%, rgba(55,226,176,.08), transparent 55%),
      radial-gradient(700px 500px at 50% 120%, rgba(192,132,252,.06), transparent 60%),
      ${T.bg}`,
    padding: "24px 18px 64px",
  },
  shell: { maxWidth: 1120, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 },

  // hero
  hero: {
    position: "relative",
    overflow: "hidden",
    border: `1px solid ${T.border}`,
    borderRadius: 22,
    padding: "26px 26px",
    background: "linear-gradient(135deg, rgba(77,163,255,.12), rgba(192,132,252,.06))",
    backdropFilter: "blur(14px)", // frost the translucent hero over the radial backdrop
    WebkitBackdropFilter: "blur(14px)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  eyebrow: {
    fontFamily: MONO,
    fontSize: 11,
    color: T.green,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  h1: { margin: 0, fontSize: 30, fontWeight: 700, lineHeight: 1.15, letterSpacing: 0.2 },
  h1grad: {
    background: `linear-gradient(90deg, ${T.blue}, ${T.green})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  heroSub: { margin: "10px 0 0", color: T.muted, fontSize: 14.5, maxWidth: 620, lineHeight: 1.6 },
  refreshBtn: {
    position: "relative",
    zIndex: 1,
    fontFamily: FONT,
    fontSize: 13,
    fontWeight: 600,
    color: T.blue,
    background: T.panel,
    border: `1px solid ${T.border2}`,
    borderRadius: 20,
    padding: "8px 15px",
    cursor: "pointer",
  },

  // add bar
  addWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    border: `1px solid ${T.border}`,
    borderRadius: 16,
    padding: "10px 12px",
    background: T.panel,
  },
  addPlus: { fontSize: 16, opacity: 0.9 },
  addInput: {
    flex: "1 1 220px",
    minWidth: 160,
    fontFamily: FONT,
    fontSize: 14.5,
    color: T.text,
    background: "transparent",
    border: "none",
    outline: "none",
    padding: "6px 4px",
  },
  addDate: {
    fontFamily: FONT,
    fontSize: 13,
    color: T.text,
    background: T.panel2,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "7px 9px",
    outline: "none",
  },
  addClearDate: {
    fontFamily: FONT,
    fontSize: 12,
    color: T.dim,
    background: "transparent",
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "6px 9px",
    cursor: "pointer",
  },
  addBtn: {
    fontFamily: FONT,
    fontSize: 14,
    fontWeight: 700,
    color: T.onAccent,
    background: `linear-gradient(90deg, ${T.blue}, ${T.green})`,
    border: "none",
    borderRadius: 10,
    padding: "9px 18px",
    cursor: "pointer",
  },

  // reminder default panel
  remindWrap: {
    border: `1px solid ${T.border}`,
    borderRadius: 16,
    padding: "12px 14px",
    background: T.panel,
    display: "flex",
    flexDirection: "column",
    gap: 9,
  },
  remindHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  remindTitle: { fontSize: 13.5, fontWeight: 700, color: T.text },
  remindSaved: {
    fontFamily: MONO,
    fontSize: 11,
    color: T.green,
    background: "rgba(55,226,176,.12)",
    border: `1px solid rgba(55,226,176,.35)`,
    borderRadius: 999,
    padding: "1px 9px",
  },
  segRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  segBtn: {
    fontFamily: FONT,
    fontSize: 12.5,
    color: T.muted,
    background: T.panel2,
    border: `1px solid ${T.border}`,
    borderRadius: 999,
    padding: "6px 13px",
  },
  segBtnOn: {
    color: T.onAccent,
    fontWeight: 700,
    background: `linear-gradient(90deg, ${T.blue}, ${T.green})`,
    borderColor: "transparent",
  },
  remindHelp: { margin: 0, color: T.dim, fontSize: 12, lineHeight: 1.55 },

  // per-task reminder override (inside a task row)
  remindPick: { display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  remindPickLabel: { fontSize: 12, color: T.dim },
  remindSelect: {
    fontFamily: FONT,
    fontSize: 12.5,
    color: T.text,
    background: T.panel2,
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    padding: "4px 8px",
    outline: "none",
    cursor: "pointer",
  },

  // two-column layout
  grid2: {
    display: "grid",
    gridTemplateColumns: "minmax(300px, 420px) 1fr",
    gap: 16,
    alignItems: "start",
  },

  // calendar
  calCard: {
    border: `1px solid ${T.border}`,
    borderRadius: 18,
    padding: 16,
    background: T.panel,
    position: "sticky",
    top: 16,
  },
  calHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  calTitle: { fontSize: 17, fontWeight: 700 },
  calNav: {
    width: 32,
    height: 32,
    borderRadius: 10,
    fontSize: 18,
    lineHeight: 1,
    color: T.text,
    background: T.panel2,
    border: `1px solid ${T.border}`,
    cursor: "pointer",
  },
  dow: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 },
  dowCell: { textAlign: "center", fontSize: 11.5, fontFamily: MONO, padding: "4px 0" },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 },
  emptyCell: { aspectRatio: "1 / 1" },
  dayCell: {
    aspectRatio: "1 / 1",
    borderRadius: 10,
    border: "1px solid transparent",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    cursor: "pointer",
    fontFamily: FONT,
    padding: 2,
    transition: "background .12s, border-color .12s",
  },
  dayNum: { fontSize: 13.5 },
  dayDots: { display: "flex", gap: 3, alignItems: "center", minHeight: 16 },
  badge: {
    minWidth: 16,
    height: 16,
    padding: "0 4px",
    borderRadius: 8,
    fontSize: 10.5,
    fontWeight: 700,
    lineHeight: "16px",
    textAlign: "center",
    border: "1px solid transparent",
  },
  badgeDone: {
    background: "rgba(255,255,255,.05)",
    color: T.dim,
    borderColor: T.border,
  },
  legend: {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
    marginTop: 12,
    paddingTop: 12,
    borderTop: `1px solid ${T.border}`,
  },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: T.muted },
  dot: { width: 9, height: 9, borderRadius: 999, display: "inline-block" },

  // list
  listCard: {
    border: `1px solid ${T.border}`,
    borderRadius: 18,
    padding: 16,
    background: T.panel,
    minHeight: 220,
  },
  listHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  listTitle: { fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 },
  listCount: {
    fontSize: 12,
    fontWeight: 700,
    color: T.blue,
    background: "rgba(77,163,255,.12)",
    border: `1px solid ${T.border2}`,
    borderRadius: 999,
    padding: "1px 9px",
  },
  chipBtn: {
    fontFamily: FONT,
    fontSize: 12.5,
    color: T.blue,
    background: T.panel2,
    border: `1px solid ${T.border2}`,
    borderRadius: 999,
    padding: "5px 12px",
    cursor: "pointer",
  },
  rows: { display: "flex", flexDirection: "column", gap: 8 },
  groupLabel: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: 12,
    fontFamily: MONO,
    letterSpacing: 0.3,
    margin: "12px 2px 6px",
  },
  groupCount: { color: T.dim, fontSize: 11.5 },

  // row
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    border: `1px solid ${T.border}`,
    borderRadius: 13,
    padding: "10px 11px",
    background: T.panel,
    transition: "border-color .12s, background .12s, opacity .12s",
  },
  check: {
    flex: "0 0 auto",
    width: 22,
    height: 22,
    marginTop: 1,
    borderRadius: 7,
    border: `1.5px solid ${T.border2}`,
    fontSize: 13,
    fontWeight: 800,
    lineHeight: 1,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
  },
  rowNum: {
    flex: "0 0 auto",
    fontFamily: MONO,
    fontSize: 12,
    color: T.dim,
    marginTop: 3,
    minWidth: 16,
    textAlign: "right",
  },
  rowMain: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
  rowText: { fontSize: 14.5, lineHeight: 1.45, wordBreak: "break-word" },
  editInput: {
    width: "100%",
    fontFamily: FONT,
    fontSize: 14.5,
    color: T.text,
    background: T.panel2,
    border: `1px solid ${T.border2}`,
    borderRadius: 9,
    padding: "7px 9px",
    outline: "none",
  },
  dueChip: {
    alignSelf: "flex-start",
    fontFamily: FONT,
    fontSize: 12.5,
    color: T.muted,
    background: "rgba(255,255,255,.03)",
    border: `1px solid ${T.border}`,
    borderRadius: 999,
    padding: "4px 11px",
    cursor: "pointer",
  },
  pickRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  pickInput: {
    fontFamily: FONT,
    fontSize: 13,
    color: T.text,
    background: T.panel2,
    border: `1px solid ${T.border2}`,
    borderRadius: 9,
    padding: "6px 8px",
    outline: "none",
  },
  rowActions: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 4 },
  reorderCol: { display: "flex", flexDirection: "column", gap: 2, marginRight: 2 },
  arrowBtn: {
    width: 22,
    height: 17,
    fontSize: 9,
    lineHeight: 1,
    color: T.muted,
    background: "transparent",
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: 0,
  },
  iconBtn: {
    width: 30,
    height: 30,
    fontSize: 14,
    color: T.muted,
    background: T.panel2,
    border: `1px solid ${T.border}`,
    borderRadius: 9,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
  },
  miniPrimary: {
    fontFamily: FONT,
    fontSize: 12.5,
    fontWeight: 700,
    color: T.onAccent,
    background: T.green,
    border: "none",
    borderRadius: 8,
    padding: "6px 11px",
    cursor: "pointer",
  },
  miniGhost: {
    fontFamily: FONT,
    fontSize: 12.5,
    color: T.muted,
    background: "transparent",
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    padding: "6px 10px",
    cursor: "pointer",
  },
  delConfirm: { display: "inline-flex", gap: 4, alignItems: "center" },
  delYes: {
    fontFamily: FONT,
    fontSize: 12.5,
    fontWeight: 700,
    color: "#fff",
    background: T.danger,
    border: "none",
    borderRadius: 8,
    padding: "6px 11px",
    cursor: "pointer",
  },

  empty: {
    color: T.muted,
    fontSize: 14,
    lineHeight: 1.6,
    padding: "22px 8px",
    textAlign: "center",
    border: `1px dashed ${T.border}`,
    borderRadius: 12,
  },
  invalidCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    border: `1px solid ${T.border}`,
    borderRadius: 18,
    padding: "44px 24px",
    background: T.panel,
  },
  footer: {
    marginTop: 6,
    color: T.dim,
    fontSize: 12.5,
    textAlign: "center",
    lineHeight: 1.6,
  },
};
