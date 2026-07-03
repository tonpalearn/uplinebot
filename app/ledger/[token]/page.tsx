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
// Layout: header + period toggle (วัน/สัปดาห์/เดือน) → 3 summary cards (รายรับ/รายจ่าย/คงเหลือ)
// → category bar chart (expenses, CSS-width bars) → transaction list (date, item, category chip,
// signed amount, delete ✕). Self-contained: no external chart libs.

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

type Period = "day" | "week" | "month";

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

  const [period, setPeriod] = useState<Period>("month");
  const [label, setLabel] = useState<string>("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
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
            <PeriodToggle period={period} onChange={setPeriod} disabled={status === "loading"} />
          )}

          {status === "invalid" && <InvalidState />}
          {status === "error" && (
            <Banner>โหลดข้อมูลไม่สำเร็จ{errMsg ? `: ${errMsg}` : ""} — ลองรีเฟรชอีกครั้ง</Banner>
          )}

          {status !== "invalid" && status !== "error" && summary && (
            <>
              <SummaryCards summary={summary} />
              <CategoryChart summary={summary} />
              <TxList entries={listed} onDelete={removeEntry} />
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
    <div style={sx.hero}>
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
    <div style={sx.cards}>
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
function TxList({ entries, onDelete }: { entries: Entry[]; onDelete: (id: string) => void }) {
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
            <TxRow key={e.id} entry={e} onDelete={onDelete} />
          ))}
        </div>
      )}
    </section>
  );
}

function TxRow({ entry, onDelete }: { entry: Entry; onDelete: (id: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const amtColor = entry.kind === "income" ? T.success : T.danger;
  return (
    <div style={sx.row}>
      <div style={sx.rowDate}>{fmtDay(entry.occurred_on)}</div>
      <div style={sx.rowMain}>
        <div style={sx.rowText}>{entry.raw_text || "(ไม่ระบุ)"}</div>
        <div style={sx.rowMeta}>
          <span style={sx.catChip}>
            {catEmoji(entry.category)} {entry.category}
          </span>
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
    background: T.bg,
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
    background: T.surface,
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

  // period toggle
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
  cards: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 },
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
    background: T.surface,
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
  noteText: { fontSize: 11.5, color: T.muted2 },
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
