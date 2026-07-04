"use client";

// Customer money report — reachable at /ledger/<token> where <token> is upl_targets.ledger_token
// (the bot sends this link via "รายงาน"). The token IS the auth: every request to
// /api/ledger/<token> revalidates it server-side and scopes reads/writes to that one LINE
// chat/group's entries. This page never sees a targetId; it only knows its token.
//
// THEME-AWARE: colors come from `T` (../../ui-theme → CSS vars in globals.css), so the page
// flips light/dark and scales with the app's font control. The per-category bar palette is a
// small fixed set (bars need distinct hues regardless of theme).
//
// Two views (view toggle): "list" = simple itemized list of the period (no charts) · "report" =
// the professional view (summary cards + category bar chart + list). BOTH views' rows carry a
// category <select> (recategorize via PATCH) + a "จำไว้" checkbox (learn:true so future same-item
// entries auto-categorize), plus the existing delete ✕. A collapsible "⚙️ จัดการหมวด" panel
// adds/hides/edits/deletes categories via /api/ledger/<token>/categories.
//
// Layout: header + view toggle (รายการ/รายงาน) + period toggle (วัน/สัปดาห์/เดือน) → manage panel
// → [list view] tx list  OR  [report view] summary cards + bar chart + tx list. No external libs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { T } from "../../ui-theme";

// ── types (mirror the API response) ─────────────────────────────────────────────
type Kind = "income" | "expense";

interface Entry {
  id: string;
  kind: Kind;
  amount: number;
  category: string;
  note: string | null;
  raw_text: string | null;
  occurred_on: string; // YYYY-MM-DD
  created_at: string;
}

interface Summary {
  income: number;
  expense: number;
  net: number;
  count: number;
  byCat: { category: string; amount: number; pct: number }[];
}

// หมวดที่มีผลจริง (จาก GET payload / categories API) — ตรงกับ EffectiveCategory ฝั่ง server
interface EffectiveCategory {
  name: string;
  emoji: string;
  kind: Kind;
  hidden: boolean;
  isCustom: boolean;
}

interface CategoriesByKind {
  income: EffectiveCategory[];
  expense: EffectiveCategory[];
}

type Period = "day" | "week" | "month";
type View = "list" | "report";

// Fixed bar palette (distinct hues; not theme-dependent). Category → color by index.
const BAR_COLORS = [
  "#0EA47F", "#3B82F6", "#D97706", "#8B5CF6", "#EF4444", "#06B6D4", "#CA8A04", "#65A30D",
];

// อีโมจิประจำหมวด (ตรงกับ lib/modules/expense-tracker/categories.ts) — เป็นของแต่งหน้าเว็บ
const CATEGORY_EMOJI: Record<string, string> = {
  กิน: "🍜", เดินทาง: "🚗", ช้อปปิ้ง: "🛍️", "บ้าน/บิล": "🏠", สุขภาพ: "💊", บันเทิง: "🎬",
  ครอบครัว: "👨‍👩‍👧", "งาน/ธุรกิจ": "💼", เงินเดือน: "💰", "ขาย/รายได้": "🛒", โบนัส: "🎁",
  "เงินคืน/ดอกเบี้ย": "↩️", อื่นๆ: "📌",
};
function catEmoji(c: string): string {
  return CATEGORY_EMOJI[c] ?? "📌";
}

const THAI_MONTHS_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

function formatTHB(n: number): string {
  const abs = Math.abs(n);
  const hasFraction = Math.round(abs * 100) % 100 !== 0;
  return abs.toLocaleString("th-TH", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}
function signed(kind: Kind, amount: number): string {
  return (kind === "income" ? "+" : "−") + formatTHB(amount);
}
function signedNet(net: number): string {
  return (net >= 0 ? "+" : "−") + formatTHB(net);
}
/** "3 ก.ค." from an occurred_on YYYY-MM-DD (no timezone math needed — it's already a BKK date). */
function fmtDay(occurredOn: string): string {
  const m = occurredOn.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return occurredOn;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return `${d} ${THAI_MONTHS_ABBR[mo - 1] ?? ""}`.trim();
}

// ── page ────────────────────────────────────────────────────────────────────────
export default function LedgerPage({ params }: { params: { token: string } }) {
  const token = params.token;
  const apiBase = `/api/ledger/${encodeURIComponent(token)}`;

  const [view, setView] = useState<View>("list");
  const [period, setPeriod] = useState<Period>("month");
  const [label, setLabel] = useState<string>("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [categories, setCategories] = useState<CategoriesByKind>({ income: [], expense: [] });
  const [status, setStatus] = useState<"loading" | "ok" | "invalid" | "error">("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const load = useCallback(
    async (p: Period) => {
      setStatus("loading");
      try {
        const res = await fetch(`${apiBase}?period=${p}`, { cache: "no-store" });
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
        setSummary(json.summary as Summary);
        setEntries((json.entries || []) as Entry[]);
        setLabel(json.label as string);
        if (json.categories) setCategories(json.categories as CategoriesByKind);
        setStatus("ok");
        setErrMsg(null);
      } catch (e) {
        setStatus("error");
        setErrMsg(e instanceof Error ? e.message : String(e));
      }
    },
    [apiBase]
  );

  useEffect(() => {
    load(period);
  }, [load, period]);

  // เปลี่ยนหมวดของรายการ (recategorize) — optimistic + PATCH; learn=จำ item→หมวดไว้ครั้งหน้า
  const recategorizeEntry = useCallback(
    async (id: string, category: string, learn: boolean) => {
      const prev = entries;
      setEntries((cur) => cur.map((e) => (e.id === id ? { ...e, category } : e)));
      try {
        const res = await fetch(apiBase, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, category, learn }),
        });
        if (!res.ok) {
          setEntries(prev); // revert
        } else {
          // totals/pct ของกราฟเปลี่ยนเมื่อย้ายหมวด — รีเฟรชจาก server
          load(period);
        }
      } catch {
        setEntries(prev);
      }
    },
    [apiBase, entries, load, period]
  );

  // หลังจัดการหมวด (add/hide/edit/delete) — รับรายการหมวดสดจาก response แล้วอัปเดต state
  const applyCategories = useCallback((kind: Kind, list: EffectiveCategory[]) => {
    setCategories((cur) => ({ ...cur, [kind]: list }));
  }, []);

  const removeEntry = useCallback(
    async (id: string) => {
      const prev = entries;
      setEntries((cur) => cur.filter((e) => e.id !== id));
      try {
        const res = await fetch(`${apiBase}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) {
          setEntries(prev); // revert
        } else {
          // refresh totals from the server (net/pct change on delete)
          load(period);
        }
      } catch {
        setEntries(prev);
      }
    },
    [apiBase, entries, load, period]
  );

  // Most-recent first for the list (occurred_on desc, then created_at desc).
  const listed = useMemo(() => {
    return entries.slice().sort((a, b) => {
      if (a.occurred_on !== b.occurred_on) return b.occurred_on.localeCompare(a.occurred_on);
      return b.created_at.localeCompare(a.created_at);
    });
  }, [entries]);

  return (
    <>
      <FontLink />
      <GlobalStyle />
      <main className="ledger-scope" style={sx.page}>
        <div style={sx.shell}>
          <Header label={label} loading={status === "loading"} onRefresh={() => load(period)} />

          {status !== "invalid" && (
            <div style={sx.toggleRow}>
              <ViewToggle view={view} onChange={setView} disabled={status === "loading"} />
              <PeriodToggle period={period} onChange={setPeriod} disabled={status === "loading"} />
            </div>
          )}

          {status === "invalid" && <InvalidState />}
          {status === "error" && (
            <Banner>โหลดข้อมูลไม่สำเร็จ{errMsg ? `: ${errMsg}` : ""} — ลองรีเฟรชอีกครั้ง</Banner>
          )}

          {status !== "invalid" && status !== "error" && summary && (
            <>
              <ManageCategories
                apiBase={apiBase}
                categories={categories}
                onApply={applyCategories}
                onEntriesChanged={() => load(period)}
              />
              {view === "report" && (
                <>
                  <SummaryCards summary={summary} />
                  <CategoryChart summary={summary} />
                </>
              )}
              <TxList
                entries={listed}
                categories={categories}
                onDelete={removeEntry}
                onRecategorize={recategorizeEntry}
              />
            </>
          )}

          <footer style={sx.footer}>
            UP Line · สมุดรายรับ-รายจ่ายของแชทนี้ — ลิงก์นี้เฉพาะกลุ่ม/แชทนี้เท่านั้น ไม่ต้องล็อกอิน
          </footer>
        </div>
      </main>
    </>
  );
}

// ── header ──────────────────────────────────────────────────────────────────────
function Header({ label, loading, onRefresh }: { label: string; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="ledger-hero" style={sx.hero}>
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={sx.eyebrow}>สมุดรายรับ-รายจ่าย · Ledger</div>
        <h1 style={sx.h1}>
          รายงาน<span style={sx.h1grad}>รายรับ-รายจ่าย</span>
        </h1>
        <p style={sx.heroSub}>
          สรุปยอด กราฟแยกหมวด และรายการทั้งหมดของแชทนี้{label ? ` · ${label}` : ""}
        </p>
      </div>
      <button onClick={onRefresh} disabled={loading} style={sx.refreshBtn}>
        {loading ? "กำลังโหลด…" : "↻ รีเฟรช"}
      </button>
    </div>
  );
}

// ── view toggle (list / report) ───────────────────────────────────────────────────
function ViewToggle({
  view,
  onChange,
  disabled,
}: {
  view: View;
  onChange: (v: View) => void;
  disabled?: boolean;
}) {
  const opts: { key: View; label: string }[] = [
    { key: "list", label: "📋 รายการ" },
    { key: "report", label: "📊 รายงาน" },
  ];
  return (
    <div style={sx.toggleWrap}>
      {opts.map((o) => {
        const active = o.key === view;
        return (
          <button
            key={o.key}
            onClick={() => !disabled && onChange(o.key)}
            disabled={disabled}
            style={{
              ...sx.toggleBtn,
              color: active ? T.primaryFg : T.fg,
              background: active ? T.primary : "transparent",
              borderColor: active ? T.primary : T.border,
              fontWeight: active ? 700 : 500,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── period toggle ─────────────────────────────────────────────────────────────────
function PeriodToggle({
  period,
  onChange,
  disabled,
}: {
  period: Period;
  onChange: (p: Period) => void;
  disabled?: boolean;
}) {
  const opts: { key: Period; label: string }[] = [
    { key: "day", label: "วัน" },
    { key: "week", label: "สัปดาห์" },
    { key: "month", label: "เดือน" },
  ];
  return (
    <div style={sx.toggleWrap}>
      {opts.map((o) => {
        const active = o.key === period;
        return (
          <button
            key={o.key}
            onClick={() => !disabled && onChange(o.key)}
            disabled={disabled}
            style={{
              ...sx.toggleBtn,
              color: active ? T.primaryFg : T.fg,
              background: active ? T.primary : "transparent",
              borderColor: active ? T.primary : T.border,
              fontWeight: active ? 700 : 500,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── summary cards ─────────────────────────────────────────────────────────────────
function SummaryCards({ summary }: { summary: Summary }) {
  const netColor = summary.net >= 0 ? T.success : T.danger;
  return (
    <div className="ledger-cards" style={sx.cards}>
      <div style={{ ...sx.card, borderColor: T.border }}>
        <div style={sx.cardLabel}>💵 รายรับ</div>
        <div style={{ ...sx.cardValue, color: T.success }}>{signed("income", summary.income)}</div>
      </div>
      <div style={{ ...sx.card, borderColor: T.border }}>
        <div style={sx.cardLabel}>💸 รายจ่าย</div>
        <div style={{ ...sx.cardValue, color: T.danger }}>{signed("expense", summary.expense)}</div>
      </div>
      <div style={{ ...sx.card, borderColor: T.border }}>
        <div style={sx.cardLabel}>✅ คงเหลือ</div>
        <div style={{ ...sx.cardValue, color: netColor }}>{signedNet(summary.net)}</div>
      </div>
    </div>
  );
}

// ── category bar chart (expenses) ───────────────────────────────────────────────
function CategoryChart({ summary }: { summary: Summary }) {
  if (summary.byCat.length === 0) {
    return (
      <section style={sx.panel}>
        <div style={sx.panelTitle}>รายจ่ายแยกหมวด</div>
        <Empty text="ยังไม่มีรายจ่ายในช่วงนี้" />
      </section>
    );
  }
  return (
    <section style={sx.panel}>
      <div style={sx.panelTitle}>รายจ่ายแยกหมวด</div>
      <div style={sx.bars}>
        {summary.byCat.map((c, i) => {
          const color = BAR_COLORS[i % BAR_COLORS.length];
          const width = `${Math.max(c.pct, 3)}%`;
          return (
            <div key={c.category} style={sx.barRow}>
              <div style={sx.barHead}>
                <span style={sx.barLabel}>
                  {catEmoji(c.category)} {c.category}
                </span>
                <span style={sx.barAmt}>
                  {formatTHB(c.amount)} <span style={{ color: T.muted2 }}>({Math.round(c.pct)}%)</span>
                </span>
              </div>
              <div style={sx.track}>
                <div style={{ ...sx.fill, width, background: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── transaction list ──────────────────────────────────────────────────────────────
function TxList({
  entries,
  categories,
  onDelete,
  onRecategorize,
}: {
  entries: Entry[];
  categories: CategoriesByKind;
  onDelete: (id: string) => void;
  onRecategorize: (id: string, category: string, learn: boolean) => void;
}) {
  return (
    <section style={sx.panel}>
      <div style={sx.panelHead}>
        <div style={sx.panelTitle}>รายการทั้งหมด</div>
        <span style={sx.countChip}>{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <Empty text="ยังไม่มีรายการในช่วงนี้ — พิมพ์บันทึกในแชท LINE ได้เลย เช่น “กาแฟ 50”" />
      ) : (
        <div style={sx.rows}>
          {entries.map((e) => (
            <TxRow
              key={e.id}
              entry={e}
              categories={categories}
              onDelete={onDelete}
              onRecategorize={onRecategorize}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TxRow({
  entry,
  categories,
  onDelete,
  onRecategorize,
}: {
  entry: Entry;
  categories: CategoriesByKind;
  onDelete: (id: string) => void;
  onRecategorize: (id: string, category: string, learn: boolean) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  // "จำไว้" ต่อแถว: เมื่อติ๊ก การเปลี่ยนหมวดครั้งถัดไปจะส่ง learn:true (จำ item→หมวดไว้ครั้งหน้า)
  const [remember, setRemember] = useState(false);
  const amtColor = entry.kind === "income" ? T.success : T.danger;

  // ตัวเลือกหมวดของ kind นี้ (กรอง hidden ออก); ถ้าหมวดปัจจุบันถูกซ่อน/หายไป ก็ยังคงเลือกไว้ให้เห็น
  const options = (entry.kind === "income" ? categories.income : categories.expense).filter(
    (c) => !c.hidden
  );
  const hasCurrent = options.some((c) => c.name === entry.category);

  return (
    <div style={sx.row}>
      <div style={sx.rowDate}>{fmtDay(entry.occurred_on)}</div>
      <div style={sx.rowMain}>
        <div style={sx.rowText}>{entry.raw_text || "(ไม่ระบุ)"}</div>
        <div style={sx.rowMeta}>
          <select
            value={entry.category}
            onChange={(ev) => {
              const next = ev.target.value;
              if (next && next !== entry.category) onRecategorize(entry.id, next, remember);
            }}
            style={sx.catSelect}
            title="เปลี่ยนหมวด"
            aria-label="เปลี่ยนหมวด"
          >
            {!hasCurrent && (
              <option value={entry.category}>
                {catEmoji(entry.category)} {entry.category}
              </option>
            )}
            {options.map((c) => (
              <option key={c.name} value={c.name}>
                {c.emoji} {c.name}
              </option>
            ))}
          </select>
          <label style={sx.rememberLabel} title="จำ: รายการชื่อเดียวกันครั้งหน้าจะเข้าหมวดนี้เอง">
            <input
              type="checkbox"
              checked={remember}
              onChange={(ev) => setRemember(ev.target.checked)}
              style={sx.rememberBox}
            />
            จำไว้
          </label>
          {entry.note && <span style={sx.noteText}>· {entry.note}</span>}
        </div>
      </div>
      <div style={{ ...sx.rowAmt, color: amtColor }}>{signed(entry.kind, entry.amount)}</div>
      {confirm ? (
        <span style={sx.delConfirm}>
          <button style={sx.delYes} onClick={() => onDelete(entry.id)}>
            ลบ
          </button>
          <button style={sx.miniGhost} onClick={() => setConfirm(false)}>
            ไม่
          </button>
        </span>
      ) : (
        <button
          style={sx.delBtn}
          onClick={() => setConfirm(true)}
          aria-label="ลบรายการ"
          title="ลบรายการ"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── manage categories panel (collapsible) ───────────────────────────────────────
function ManageCategories({
  apiBase,
  categories,
  onApply,
  onEntriesChanged,
}: {
  apiBase: string;
  categories: CategoriesByKind;
  onApply: (kind: Kind, list: EffectiveCategory[]) => void;
  onEntriesChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ยิงคำสั่งจัดการหมวด → รับ categories สดกลับมา แล้ว apply เข้า state (refresh in place)
  const call = useCallback(
    async (
      method: "POST" | "PATCH" | "DELETE",
      kind: Kind,
      payload: Record<string, unknown>,
      migratesEntries = false
    ) => {
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch(`${apiBase}/categories`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, ...payload }),
        });
        const json = await res.json();
        if (!res.ok || !json?.ok) {
          setErr(json?.reason || `HTTP ${res.status}`);
          return false;
        }
        onApply(kind, (json.categories || []) as EffectiveCategory[]);
        // rename/delete ย้าย entries ด้วย → รีเฟรชรายการ/ยอดรวม
        if (migratesEntries) onEntriesChanged();
        return true;
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apiBase, onApply, onEntriesChanged]
  );

  return (
    <section style={sx.panel}>
      <button
        style={sx.manageToggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>⚙️ จัดการหมวด</span>
        <span style={sx.manageChevron}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={sx.manageBody}>
          {err && <Banner>จัดการหมวดไม่สำเร็จ: {err}</Banner>}
          <ManageKind
            kind="expense"
            title="รายจ่าย"
            list={categories.expense}
            busy={busy}
            call={call}
          />
          <ManageKind
            kind="income"
            title="รายรับ"
            list={categories.income}
            busy={busy}
            call={call}
          />
        </div>
      )}
    </section>
  );
}

// จัดการหมวดของ kind เดียว: รายการหมวด (แก้อีโมจิ/เปลี่ยนชื่อ/ซ่อน/ลบ) + ฟอร์มเพิ่มหมวด
function ManageKind({
  kind,
  title,
  list,
  busy,
  call,
}: {
  kind: Kind;
  title: string;
  list: EffectiveCategory[];
  busy: boolean;
  call: (
    method: "POST" | "PATCH" | "DELETE",
    kind: Kind,
    payload: Record<string, unknown>,
    migratesEntries?: boolean
  ) => Promise<boolean>;
}) {
  const [newName, setNewName] = useState("");
  const [newEmoji, setNewEmoji] = useState("");

  const add = async () => {
    if (!newName.trim()) return;
    const ok = await call("POST", kind, { name: newName.trim(), emoji: newEmoji.trim() || undefined });
    if (ok) {
      setNewName("");
      setNewEmoji("");
    }
  };

  return (
    <div style={sx.manageKind}>
      <div style={sx.manageKindTitle}>{title}</div>
      <div style={sx.manageList}>
        {list.map((c) => (
          <ManageCatRow key={c.name} kind={kind} cat={c} busy={busy} call={call} />
        ))}
      </div>
      <div style={sx.addRow}>
        <input
          value={newEmoji}
          onChange={(e) => setNewEmoji(e.target.value)}
          placeholder="🙂"
          style={sx.addEmoji}
          maxLength={4}
          aria-label="อีโมจิหมวดใหม่"
        />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="เพิ่มหมวดใหม่…"
          style={sx.addName}
          aria-label="ชื่อหมวดใหม่"
        />
        <button style={sx.addBtn} onClick={add} disabled={busy || !newName.trim()}>
          + เพิ่ม
        </button>
      </div>
    </div>
  );
}

// หนึ่งแถวหมวดในหน้าจัดการ: อีโมจิ+ชื่อ · ปุ่มแก้ (custom) · ซ่อน/เปิด · ลบ (custom)
function ManageCatRow({
  kind,
  cat,
  busy,
  call,
}: {
  kind: Kind;
  cat: EffectiveCategory;
  busy: boolean;
  call: (
    method: "POST" | "PATCH" | "DELETE",
    kind: Kind,
    payload: Record<string, unknown>,
    migratesEntries?: boolean
  ) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [emoji, setEmoji] = useState(cat.emoji);
  const [name, setName] = useState(cat.name);
  const isFallback = cat.name === "อื่นๆ";

  const saveEdit = async () => {
    const patch: Record<string, unknown> = {};
    if (emoji.trim() && emoji.trim() !== cat.emoji) patch.emoji = emoji.trim();
    // เปลี่ยนชื่อได้เฉพาะ custom (built-in rename ไม่รองรับ → server ปฏิเสธ)
    if (cat.isCustom && name.trim() && name.trim() !== cat.name) patch.newName = name.trim();
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    const ok = await call("PATCH", kind, { name: cat.name, ...patch }, Boolean(patch.newName));
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <div style={sx.manageRow}>
        <input
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          style={sx.editEmoji}
          maxLength={4}
          aria-label="อีโมจิ"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={sx.editName}
          disabled={!cat.isCustom}
          aria-label="ชื่อหมวด"
        />
        <button style={sx.miniPrimary} onClick={saveEdit} disabled={busy}>
          บันทึก
        </button>
        <button style={sx.miniGhost} onClick={() => setEditing(false)} disabled={busy}>
          ยกเลิก
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...sx.manageRow, opacity: cat.hidden ? 0.5 : 1 }}>
      <span style={sx.manageCatName}>
        {cat.emoji} {cat.name}
        {cat.isCustom && <span style={sx.customTag}>custom</span>}
        {cat.hidden && <span style={sx.hiddenTag}>ซ่อน</span>}
      </span>
      <button
        style={sx.miniIcon}
        onClick={() => {
          setEmoji(cat.emoji);
          setName(cat.name);
          setEditing(true);
        }}
        disabled={busy}
        title="แก้อีโมจิ/ชื่อ"
        aria-label="แก้ไข"
      >
        ✎
      </button>
      {!isFallback && (
        <button
          style={sx.miniIcon}
          onClick={() => call("PATCH", kind, { name: cat.name, hidden: !cat.hidden })}
          disabled={busy}
          title={cat.hidden ? "เปิดหมวดนี้" : "ซ่อนหมวดนี้"}
          aria-label={cat.hidden ? "เปิด" : "ซ่อน"}
        >
          {cat.hidden ? "🙈" : "👁"}
        </button>
      )}
      {cat.isCustom && (
        <button
          style={sx.miniIconDanger}
          onClick={() => call("DELETE", kind, { name: cat.name }, true)}
          disabled={busy}
          title="ลบหมวด (รายการเดิมจะย้ายไป อื่นๆ)"
          aria-label="ลบ"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────────
function Empty({ text }: { text: string }) {
  return <div style={sx.empty}>{text}</div>;
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13.5,
        color: T.danger,
        background: T.dangerWeak,
        border: `1px solid ${T.danger}44`,
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
        ลิงก์รายงานไม่ถูกต้องหรือหมดอายุแล้ว — พิมพ์ <b style={{ color: T.fg }}>รายงาน</b> ในแชท LINE
        กับบอทอีกครั้ง เพื่อรับลิงก์ใหม่ของกลุ่ม/แชทนี้
      </p>
    </div>
  );
}

// Load IBM Plex Sans Thai + JetBrains Mono (matches the planner page).
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

// Page-scoped global CSS: body background + custom scrollbars (theme-var driven).
function GlobalStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        html,body{margin:0;padding:0;background:${T.bg};}
        *{box-sizing:border-box;}
        .ledger-scope ::-webkit-scrollbar{width:9px;height:9px;}
        .ledger-scope ::-webkit-scrollbar-thumb{background:${T.borderStrong};border-radius:8px;}
        .ledger-scope ::-webkit-scrollbar-track{background:transparent;}
        /* ── mobile (LINE in-app browser ~375–430px): tighten, shrink hero, keep 3 stat cards ── */
        @media (max-width:560px){
          .ledger-scope{padding:16px 12px 48px !important;}
          .ledger-hero{padding:20px 18px !important;border-radius:18px !important;}
          .ledger-hero h1{font-size:23px !important;}
          .ledger-cards{gap:8px !important;}
          .ledger-cards > div{padding:12px 11px !important;}
          .ledger-cards > div > div:nth-child(2){font-size:16px !important;}
        }
      `,
      }}
    />
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────
const FONT = "var(--font-sans)";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

const sx: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    fontFamily: FONT,
    color: T.fg,
    background: "transparent", // let the global --bg-tint radial backdrop show → glass depth
    padding: "24px 18px 64px",
  },
  shell: { maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 },

  // hero
  hero: {
    position: "relative",
    overflow: "hidden",
    border: `1px solid ${T.border}`,
    borderRadius: 22,
    padding: "26px 26px",
    background: T.surfaceGlass, // frosted glass — translucent surface over the tinted backdrop
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
    boxShadow: T.shadowSm,
  },
  eyebrow: {
    fontFamily: MONO,
    fontSize: 11,
    color: T.primary,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  h1: { margin: 0, fontSize: 28, fontWeight: 700, lineHeight: 1.15, letterSpacing: 0.2 },
  h1grad: {
    background: `linear-gradient(90deg, ${T.primary}, ${T.success})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  heroSub: { margin: "10px 0 0", color: T.muted, fontSize: 14, maxWidth: 560, lineHeight: 1.6 },
  refreshBtn: {
    position: "relative",
    zIndex: 1,
    fontFamily: FONT,
    fontSize: 13,
    fontWeight: 600,
    color: T.primary,
    background: T.surface2,
    border: `1px solid ${T.borderStrong}`,
    borderRadius: 20,
    padding: "8px 15px",
    cursor: "pointer",
  },

  // view + period toggles (share one row, wrap on mobile)
  toggleRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  toggleWrap: {
    display: "inline-flex",
    gap: 6,
    alignSelf: "flex-start",
    padding: 4,
    borderRadius: 999,
    background: T.surface,
    border: `1px solid ${T.border}`,
  },
  toggleBtn: {
    fontFamily: FONT,
    fontSize: 13.5,
    border: "1px solid transparent",
    borderRadius: 999,
    padding: "7px 18px",
    cursor: "pointer",
    transition: "background .12s, color .12s",
  },

  // summary cards
  cards: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 },
  card: {
    border: `1px solid ${T.border}`,
    borderRadius: 16,
    padding: "14px 16px",
    background: T.surface,
    boxShadow: T.shadowSm,
  },
  cardLabel: { fontSize: 12.5, color: T.muted, marginBottom: 6 },
  cardValue: { fontSize: 20, fontWeight: 800, letterSpacing: 0.2, wordBreak: "break-word" },

  // panels
  panel: {
    border: `1px solid ${T.border}`,
    borderRadius: 18,
    padding: 16,
    background: T.surfaceGlass, // frosted glass panels (report surfaces)
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    boxShadow: T.shadowSm,
  },
  panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  panelTitle: { fontSize: 15, fontWeight: 700, color: T.fgStrong, marginBottom: 12 },
  countChip: {
    fontSize: 12,
    fontWeight: 700,
    color: T.primary,
    background: T.primaryWeak,
    border: `1px solid ${T.borderStrong}`,
    borderRadius: 999,
    padding: "1px 9px",
  },

  // bar chart
  bars: { display: "flex", flexDirection: "column", gap: 12 },
  barRow: { display: "flex", flexDirection: "column", gap: 5 },
  barHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  barLabel: { fontSize: 13, color: T.fg },
  barAmt: { fontSize: 12.5, color: T.fg, fontFamily: MONO },
  track: {
    height: 12,
    borderRadius: 6,
    background: T.surface2,
    overflow: "hidden",
  },
  fill: { height: 12, borderRadius: 6, transition: "width .2s" },

  // tx list
  rows: { display: "flex", flexDirection: "column", gap: 8 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    border: `1px solid ${T.border}`,
    borderRadius: 13,
    padding: "10px 12px",
    background: T.surface,
  },
  rowDate: {
    flex: "0 0 auto",
    fontFamily: MONO,
    fontSize: 11.5,
    color: T.muted2,
    minWidth: 52,
  },
  rowMain: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
  rowText: { fontSize: 14.5, color: T.fg, lineHeight: 1.4, wordBreak: "break-word" },
  rowMeta: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  catChip: {
    fontSize: 11.5,
    color: T.muted,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 999,
    padding: "1px 9px",
  },
  // per-row category selector + "จำไว้" checkbox
  catSelect: {
    fontFamily: FONT,
    fontSize: 11.5,
    color: T.fg,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 999,
    padding: "2px 8px",
    maxWidth: 170,
    cursor: "pointer",
  },
  rememberLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: T.muted2,
    cursor: "pointer",
    userSelect: "none",
  },
  rememberBox: { width: 13, height: 13, accentColor: T.primary, cursor: "pointer" },
  noteText: { fontSize: 11.5, color: T.muted2 },

  // manage-categories panel
  manageToggle: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontFamily: FONT,
    fontSize: 14.5,
    fontWeight: 700,
    color: T.fgStrong,
    background: "transparent",
    border: "none",
    padding: 0,
    cursor: "pointer",
  },
  manageChevron: { fontSize: 11, color: T.muted },
  manageBody: { display: "flex", flexDirection: "column", gap: 16, marginTop: 14 },
  manageKind: { display: "flex", flexDirection: "column", gap: 8 },
  manageKindTitle: { fontSize: 13, fontWeight: 700, color: T.primary },
  manageList: { display: "flex", flexDirection: "column", gap: 6 },
  manageRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "6px 10px",
    background: T.surface,
  },
  manageCatName: { flex: 1, minWidth: 0, fontSize: 13.5, color: T.fg, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  customTag: {
    fontSize: 9.5,
    fontWeight: 700,
    color: T.primary,
    background: T.primaryWeak,
    borderRadius: 6,
    padding: "0 5px",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  hiddenTag: {
    fontSize: 9.5,
    fontWeight: 700,
    color: T.muted2,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: "0 5px",
  },
  addRow: { display: "flex", gap: 6, alignItems: "center", marginTop: 2 },
  addEmoji: {
    fontFamily: FONT,
    fontSize: 13.5,
    width: 44,
    textAlign: "center",
    color: T.fg,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 9,
    padding: "6px 4px",
  },
  addName: {
    flex: 1,
    minWidth: 0,
    fontFamily: FONT,
    fontSize: 13.5,
    color: T.fg,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 9,
    padding: "6px 10px",
  },
  addBtn: {
    fontFamily: FONT,
    fontSize: 12.5,
    fontWeight: 700,
    color: T.primaryFg,
    background: T.primary,
    border: "none",
    borderRadius: 9,
    padding: "7px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  editEmoji: {
    fontFamily: FONT,
    fontSize: 13.5,
    width: 44,
    textAlign: "center",
    color: T.fg,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    padding: "5px 4px",
  },
  editName: {
    flex: 1,
    minWidth: 0,
    fontFamily: FONT,
    fontSize: 13.5,
    color: T.fg,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    padding: "5px 9px",
  },
  miniPrimary: {
    fontFamily: FONT,
    fontSize: 12,
    fontWeight: 700,
    color: T.primaryFg,
    background: T.primary,
    border: "none",
    borderRadius: 8,
    padding: "6px 10px",
    cursor: "pointer",
  },
  miniIcon: {
    flex: "0 0 auto",
    width: 28,
    height: 28,
    fontSize: 13,
    color: T.muted,
    background: "transparent",
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
  },
  miniIconDanger: {
    flex: "0 0 auto",
    width: 28,
    height: 28,
    fontSize: 12,
    color: T.danger,
    background: "transparent",
    border: `1px solid ${T.danger}55`,
    borderRadius: 8,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
  },
  rowAmt: {
    flex: "0 0 auto",
    fontSize: 15,
    fontWeight: 800,
    fontFamily: MONO,
    whiteSpace: "nowrap",
  },
  delBtn: {
    flex: "0 0 auto",
    width: 28,
    height: 28,
    fontSize: 13,
    color: T.muted2,
    background: "transparent",
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
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
    background: T.surface,
  },
  footer: {
    marginTop: 6,
    color: T.muted2,
    fontSize: 12.5,
    textAlign: "center",
    lineHeight: 1.6,
  },
};
