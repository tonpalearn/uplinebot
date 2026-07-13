"use client";

// Knowledge Base admin — reachable at /km/<token> where <token> is upl_tenants.km_token (the bot
// sends this link via "คลังความรู้"). The token IS the auth: every request to /api/km/<token>
// revalidates it server-side and scopes reads/writes to that ONE tenant's KB. This page never sees
// a tenantId; it only knows its token.
//
// THEME-AWARE: colors come from `T` (../../ui-theme → CSS vars in globals.css), so the page flips
// light/dark and scales with the app font control. The module identity is GREEN (T.success),
// matching the in-chat KM Flex card.
//
// Sections: glass hero → add-entry form → 🔎 test-query box → 📄 paste-document box →
// ❓ unanswered queue → entries list (inline edit / enable / delete). No external libs.

import { useCallback, useEffect, useState } from "react";
import { T } from "../../ui-theme";

// ── types (mirror the API response) ─────────────────────────────────────────────
interface Entry {
  id: string;
  question: string;
  answer: string;
  keywords: string | null;
  source: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface Unanswered {
  id: string;
  question: string;
  target_id: string | null;
  ask_count: number;
  resolved: boolean;
  created_at: string;
  last_asked_at: string;
}

interface SearchHit {
  id: string;
  question: string;
  answer: string;
  source: string;
  score: number;
}

const ACCENT = T.success; // module identity = GREEN

function sourceLabel(source: string): string {
  if (!source || source === "manual") return "เพิ่มเอง";
  if (source === "chat") return "สอนในแชท";
  if (source === "document") return "จากเอกสาร";
  return source;
}

// ── page ────────────────────────────────────────────────────────────────────────
export default function KmPage({ params }: { params: { token: string } }) {
  const token = params.token;
  const apiBase = `/api/km/${encodeURIComponent(token)}`;

  const [entries, setEntries] = useState<Entry[]>([]);
  const [unanswered, setUnanswered] = useState<Unanswered[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "invalid" | "error">("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
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
      setEntries((json.entries || []) as Entry[]);
      setUnanswered((json.unanswered || []) as Unanswered[]);
      setStatus("ok");
      setErrMsg(null);
    } catch (e) {
      setStatus("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  }, [apiBase]);

  useEffect(() => {
    load();
  }, [load]);

  const addEntry = useCallback(
    async (question: string, answer: string, keywords: string) => {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer, keywords: keywords || undefined }),
      });
      if (res.ok) load();
      return res.ok;
    },
    [apiBase, load]
  );

  const saveEntry = useCallback(
    async (id: string, patch: Partial<Pick<Entry, "question" | "answer" | "keywords" | "enabled">>) => {
      const res = await fetch(apiBase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (res.ok) load();
      return res.ok;
    },
    [apiBase, load]
  );

  const removeEntry = useCallback(
    async (id: string) => {
      const prev = entries;
      setEntries((cur) => cur.filter((e) => e.id !== id));
      const res = await fetch(`${apiBase}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) setEntries(prev);
    },
    [apiBase, entries]
  );

  const resolveUnanswered = useCallback(
    async (unansweredId: string, question: string, answer: string) => {
      const res = await fetch(apiBase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unansweredId, question, answer }),
      });
      if (res.ok) load();
      return res.ok;
    },
    [apiBase, load]
  );

  const addDocument = useCallback(
    async (document: string): Promise<number | null> => {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        load();
        return Number(json.added) || 0;
      }
      return null;
    },
    [apiBase, load]
  );

  return (
    <>
      <FontLink />
      <GlobalStyle />
      <main className="km-scope" style={sx.page}>
        <div style={sx.shell}>
          <Header count={entries.length} loading={status === "loading"} onRefresh={load} />

          {status === "invalid" && <InvalidState />}
          {status === "error" && (
            <Banner>โหลดข้อมูลไม่สำเร็จ{errMsg ? `: ${errMsg}` : ""} — ลองรีเฟรชอีกครั้ง</Banner>
          )}

          {status !== "invalid" && status !== "error" && (
            <>
              <AddEntryForm onAdd={addEntry} />
              <TestQueryBox apiBase={apiBase} />
              <PasteDocBox onAdd={addDocument} />
              <UnansweredQueue items={unanswered} onResolve={resolveUnanswered} />
              <EntriesList entries={entries} onSave={saveEntry} onDelete={removeEntry} />
            </>
          )}

          <footer style={sx.footer}>
            UP Line · คลังความรู้ของธุรกิจนี้ — ลิงก์นี้จัดการได้ทั้งคลัง แชร์เฉพาะแอดมิน
          </footer>
        </div>
      </main>
    </>
  );
}

// ── header ──────────────────────────────────────────────────────────────────────
function Header({ count, loading, onRefresh }: { count: number; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="km-hero" style={sx.hero}>
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={sx.eyebrow}>คลังความรู้ · Knowledge Base</div>
        <h1 style={sx.h1}>
          สอนบอทให้<span style={sx.h1grad}>ตอบคำถาม</span>
        </h1>
        <p style={sx.heroSub}>
          เพิ่มคำถาม-คำตอบ วางเอกสารให้ระบบแตกเป็นความรู้ ทดสอบว่าบอทจะตอบอะไร และเคลียร์คำถามที่ตอบไม่ได้
          {count > 0 ? ` · ${count} ความรู้` : ""}
        </p>
      </div>
      <button onClick={onRefresh} disabled={loading} style={sx.refreshBtn}>
        {loading ? "กำลังโหลด…" : "↻ รีเฟรช"}
      </button>
    </div>
  );
}

// ── add-entry form ────────────────────────────────────────────────────────────────
function AddEntryForm({
  onAdd,
}: {
  onAdd: (question: string, answer: string, keywords: string) => Promise<boolean>;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [keywords, setKeywords] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!question.trim() || !answer.trim()) return;
    setBusy(true);
    const ok = await onAdd(question.trim(), answer.trim(), keywords.trim());
    setBusy(false);
    if (ok) {
      setQuestion("");
      setAnswer("");
      setKeywords("");
    }
  };

  return (
    <section style={sx.panel}>
      <div style={sx.panelTitle}>➕ เพิ่มความรู้</div>
      <div style={sx.formGrid}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="คำถาม เช่น คืนสินค้าได้ไหม"
          style={sx.input}
          aria-label="คำถาม"
        />
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="คำตอบที่บอทจะตอบกลับ"
          style={sx.textarea}
          rows={3}
          aria-label="คำตอบ"
        />
        <input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="คำค้นเพิ่มเติม (ไม่บังคับ) เช่น คืนของ, เปลี่ยนสินค้า, refund"
          style={sx.input}
          aria-label="คำค้นเพิ่มเติม"
        />
        <div style={sx.formActions}>
          <button style={sx.primaryBtn} onClick={submit} disabled={busy || !question.trim() || !answer.trim()}>
            {busy ? "กำลังบันทึก…" : "+ เพิ่มความรู้"}
          </button>
        </div>
      </div>
    </section>
  );
}

// ── test-query box ──────────────────────────────────────────────────────────────
function TestQueryBox({ apiBase }: { apiBase: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${apiBase}?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setErr(json?.reason || `HTTP ${res.status}`);
        setHits(null);
      } else {
        setHits((json.results || []) as SearchHit[]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={sx.panel}>
      <div style={sx.panelTitle}>🔎 ทดสอบคำถาม</div>
      <div style={sx.hint}>พิมพ์คำถามแบบที่ลูกค้าถาม แล้วดูว่าบอทจะดึงความรู้ไหนมาตอบ (พร้อมคะแนนความใกล้เคียง)</div>
      <div className="km-inline-row" style={sx.inlineRow}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          placeholder="เช่น อยากคืนของทำยังไง"
          style={sx.input}
          aria-label="คำถามทดสอบ"
        />
        <button style={sx.primaryBtn} onClick={run} disabled={busy || !q.trim()}>
          {busy ? "…" : "ทดสอบ"}
        </button>
      </div>
      {err && <Banner>ทดสอบไม่สำเร็จ: {err}</Banner>}
      {hits !== null && (
        <div style={sx.results}>
          {hits.length === 0 ? (
            <Empty text="ไม่มีความรู้ที่ใกล้เคียงพอ — บอทจะตอบว่า “ยังไม่มีคำตอบ” และบันทึกคำถามนี้เข้าคิว" />
          ) : (
            hits.map((h, i) => (
              <div key={h.id} style={sx.resultRow}>
                <div style={sx.resultRank}>{i + 1}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={sx.resultQ}>{h.question}</div>
                  <div style={sx.resultA}>{h.answer}</div>
                </div>
                <div style={sx.scoreChip} title="คะแนนความใกล้เคียง (trigram)">
                  {h.score.toFixed(2)}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

// ── paste-document box ────────────────────────────────────────────────────────────
function PasteDocBox({ onAdd }: { onAdd: (document: string) => Promise<number | null> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    const added = await onAdd(text);
    setBusy(false);
    if (added === null) {
      setErr("แตกเอกสารไม่สำเร็จ — ลองจัดรูปแบบเป็นย่อหน้า หรือ Q:/A: แล้วลองใหม่");
    } else {
      setMsg(`เพิ่ม ${added} ความรู้`);
      setText("");
    }
  };

  return (
    <section style={sx.panel}>
      <div style={sx.panelTitle}>📄 วางเอกสาร</div>
      <div style={sx.hint}>
        วางข้อความยาว ๆ ระบบจะแตกเป็นความรู้อัตโนมัติ — รองรับคู่ <code style={sx.code}>Q: / A:</code> (หรือ{" "}
        <code style={sx.code}>ถาม: / ตอบ:</code>) และการแบ่งย่อหน้าด้วยบรรทัดว่าง (บรรทัดแรก = คำถาม)
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"เช่น\nQ: เปิดกี่โมง\nA: 9:00-18:00 ทุกวัน\n\nQ: ส่งของกี่วัน\nA: 2-3 วันทำการ"}
        style={{ ...sx.textarea, minHeight: 120 }}
        rows={6}
        aria-label="เอกสารที่จะแตกเป็นความรู้"
      />
      <div style={sx.formActions}>
        {msg && <span style={sx.okMsg}>✅ {msg}</span>}
        {err && <span style={sx.errMsgInline}>{err}</span>}
        <button style={sx.primaryBtn} onClick={submit} disabled={busy || !text.trim()}>
          {busy ? "กำลังแตกเอกสาร…" : "แตกเป็นความรู้"}
        </button>
      </div>
    </section>
  );
}

// ── unanswered queue ──────────────────────────────────────────────────────────────
function UnansweredQueue({
  items,
  onResolve,
}: {
  items: Unanswered[];
  onResolve: (unansweredId: string, question: string, answer: string) => Promise<boolean>;
}) {
  return (
    <section style={sx.panel}>
      <div style={sx.panelHead}>
        <div style={sx.panelTitle}>❓ คำถามที่ตอบไม่ได้</div>
        <span style={sx.countChip}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <Empty text="ยังไม่มีคำถามค้าง — เมื่อลูกค้าถามสิ่งที่คลังยังไม่มี จะโผล่ที่นี่ให้ตอบ" />
      ) : (
        <div style={sx.rows}>
          {items.map((u) => (
            <UnansweredRow key={u.id} item={u} onResolve={onResolve} />
          ))}
        </div>
      )}
    </section>
  );
}

function UnansweredRow({
  item,
  onResolve,
}: {
  item: Unanswered;
  onResolve: (unansweredId: string, question: string, answer: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState(item.question);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!answer.trim() || !question.trim()) return;
    setBusy(true);
    await onResolve(item.id, question.trim(), answer.trim());
    setBusy(false);
  };

  return (
    <div style={sx.qRow}>
      <div style={sx.qHead}>
        <span style={sx.qText}>{item.question}</span>
        {item.ask_count > 1 && <span style={sx.askChip}>ถาม {item.ask_count} ครั้ง</span>}
        <button style={sx.miniGhost} onClick={() => setOpen((o) => !o)}>
          {open ? "ปิด" : "ตอบ"}
        </button>
      </div>
      {open && (
        <div style={sx.qAnswerArea}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="คำถาม (แก้ให้กระชับได้)"
            style={sx.input}
            aria-label="คำถาม"
          />
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="พิมพ์คำตอบ แล้วระบบจะบันทึกเข้าคลัง + ปิดคำถามนี้"
            style={sx.textarea}
            rows={2}
            aria-label="คำตอบ"
          />
          <div style={sx.formActions}>
            <button style={sx.primaryBtn} onClick={submit} disabled={busy || !answer.trim() || !question.trim()}>
              {busy ? "กำลังบันทึก…" : "บันทึกเข้าคลัง"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── entries list ──────────────────────────────────────────────────────────────────
function EntriesList({
  entries,
  onSave,
  onDelete,
}: {
  entries: Entry[];
  onSave: (
    id: string,
    patch: Partial<Pick<Entry, "question" | "answer" | "keywords" | "enabled">>
  ) => Promise<boolean>;
  onDelete: (id: string) => void;
}) {
  return (
    <section style={sx.panel}>
      <div style={sx.panelHead}>
        <div style={sx.panelTitle}>📚 ความรู้ทั้งหมด</div>
        <span style={sx.countChip}>{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <Empty text="ยังไม่มีความรู้ — เพิ่มด้านบน หรือพิมพ์ในแชท LINE ว่า “สอน คำถาม = คำตอบ”" />
      ) : (
        <div style={sx.rows}>
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} onSave={onSave} onDelete={onDelete} />
          ))}
        </div>
      )}
    </section>
  );
}

function EntryRow({
  entry,
  onSave,
  onDelete,
}: {
  entry: Entry;
  onSave: (
    id: string,
    patch: Partial<Pick<Entry, "question" | "answer" | "keywords" | "enabled">>
  ) => Promise<boolean>;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(entry.question);
  const [answer, setAnswer] = useState(entry.answer);
  const [keywords, setKeywords] = useState(entry.keywords ?? "");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!question.trim() || !answer.trim()) return;
    setBusy(true);
    const ok = await onSave(entry.id, {
      question: question.trim(),
      answer: answer.trim(),
      keywords: keywords.trim(),
    });
    setBusy(false);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <div style={sx.editCard}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} style={sx.input} aria-label="คำถาม" />
        <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} style={sx.textarea} rows={3} aria-label="คำตอบ" />
        <input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="คำค้นเพิ่มเติม (ไม่บังคับ)"
          style={sx.input}
          aria-label="คำค้นเพิ่มเติม"
        />
        <div style={sx.formActions}>
          <button style={sx.miniGhost} onClick={() => setEditing(false)} disabled={busy}>
            ยกเลิก
          </button>
          <button style={sx.primaryBtn} onClick={save} disabled={busy || !question.trim() || !answer.trim()}>
            {busy ? "…" : "บันทึก"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="km-entry" style={{ ...sx.entryCard, opacity: entry.enabled ? 1 : 0.55 }}>
      <div style={sx.entryMain}>
        <div style={sx.entryQ}>{entry.question}</div>
        <div style={sx.entryA}>{entry.answer}</div>
        <div style={sx.entryMeta}>
          <span style={sx.sourceTag}>{sourceLabel(entry.source)}</span>
          {entry.keywords && <span style={sx.kwTag}>🔑 {entry.keywords}</span>}
          {!entry.enabled && <span style={sx.offTag}>ปิดอยู่</span>}
        </div>
      </div>
      <div className="km-entry-actions" style={sx.entryActions}>
        <button
          style={sx.miniIcon}
          onClick={() => onSave(entry.id, { enabled: !entry.enabled })}
          title={entry.enabled ? "ปิดใช้ความรู้นี้" : "เปิดใช้ความรู้นี้"}
          aria-label={entry.enabled ? "ปิด" : "เปิด"}
        >
          {entry.enabled ? "👁" : "🙈"}
        </button>
        <button
          style={sx.miniIcon}
          onClick={() => {
            setQuestion(entry.question);
            setAnswer(entry.answer);
            setKeywords(entry.keywords ?? "");
            setEditing(true);
          }}
          title="แก้ไข"
          aria-label="แก้ไข"
        >
          ✎
        </button>
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
          <button style={sx.miniIconDanger} onClick={() => setConfirm(true)} title="ลบ" aria-label="ลบ">
            ✕
          </button>
        )}
      </div>
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
        ลิงก์คลังความรู้ไม่ถูกต้องหรือหมดอายุแล้ว — พิมพ์ <b style={{ color: T.fg }}>คลังความรู้</b> ในแชท LINE
        กับบอทอีกครั้ง เพื่อรับลิงก์ใหม่
      </p>
    </div>
  );
}

// Load IBM Plex Sans Thai + JetBrains Mono (matches the ledger/planner pages).
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

// Page-scoped global CSS: body background + custom scrollbars + mobile responsiveness.
function GlobalStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        html,body{margin:0;padding:0;background:${T.bg};}
        *{box-sizing:border-box;}
        .km-scope ::-webkit-scrollbar{width:9px;height:9px;}
        .km-scope ::-webkit-scrollbar-thumb{background:${T.borderStrong};border-radius:8px;}
        .km-scope ::-webkit-scrollbar-track{background:transparent;}
        /* ── mobile (LINE in-app browser ~375–430px): tighten, shrink hero, stack action rows ── */
        @media (max-width:560px){
          .km-scope{padding:16px 12px 48px !important;}
          .km-hero{padding:20px 18px !important;border-radius:18px !important;}
          .km-hero h1{font-size:23px !important;}
          .km-inline-row{flex-direction:column !important;align-items:stretch !important;}
          .km-entry{flex-direction:column !important;}
          .km-entry-actions{align-self:flex-end !important;}
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
    background: "transparent",
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
    background: T.surfaceGlass,
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
    color: ACCENT,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  h1: { margin: 0, fontSize: 28, fontWeight: 700, lineHeight: 1.15, letterSpacing: 0.2 },
  h1grad: {
    background: `linear-gradient(90deg, ${T.success}, ${T.primary})`,
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
    color: ACCENT,
    background: T.surface2,
    border: `1px solid ${T.borderStrong}`,
    borderRadius: 20,
    padding: "8px 15px",
    cursor: "pointer",
  },

  // panels
  panel: {
    border: `1px solid ${T.border}`,
    borderRadius: 18,
    padding: 16,
    background: T.surfaceGlass,
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    boxShadow: T.shadowSm,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  panelTitle: { fontSize: 15, fontWeight: 700, color: T.fgStrong },
  hint: { fontSize: 12.5, color: T.muted, lineHeight: 1.55 },
  code: {
    fontFamily: MONO,
    fontSize: 11.5,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: "1px 5px",
  },
  countChip: {
    fontSize: 12,
    fontWeight: 700,
    color: ACCENT,
    background: T.successWeak,
    border: `1px solid ${T.borderStrong}`,
    borderRadius: 999,
    padding: "1px 9px",
  },

  // forms
  formGrid: { display: "flex", flexDirection: "column", gap: 8 },
  inlineRow: { display: "flex", gap: 8, alignItems: "center" },
  input: {
    fontFamily: FONT,
    fontSize: 14,
    width: "100%",
    color: T.fg,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "9px 12px",
  },
  textarea: {
    fontFamily: FONT,
    fontSize: 14,
    width: "100%",
    color: T.fg,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "9px 12px",
    lineHeight: 1.55,
    resize: "vertical",
  },
  formActions: { display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" },
  primaryBtn: {
    fontFamily: FONT,
    fontSize: 13.5,
    fontWeight: 700,
    color: "#fff",
    background: ACCENT,
    border: "none",
    borderRadius: 10,
    padding: "9px 16px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  // test-query results
  results: { display: "flex", flexDirection: "column", gap: 8, marginTop: 2 },
  resultRow: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    padding: "10px 12px",
    background: T.surface,
  },
  resultRank: {
    flex: "0 0 auto",
    width: 22,
    height: 22,
    borderRadius: 11,
    background: T.successWeak,
    color: ACCENT,
    fontSize: 12,
    fontWeight: 700,
    display: "grid",
    placeItems: "center",
  },
  resultQ: { fontSize: 14, fontWeight: 700, color: T.fg, wordBreak: "break-word" },
  resultA: { fontSize: 13, color: T.muted, marginTop: 2, lineHeight: 1.5, wordBreak: "break-word" },
  scoreChip: {
    flex: "0 0 auto",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 600,
    color: ACCENT,
    background: T.successWeak,
    border: `1px solid ${T.borderStrong}`,
    borderRadius: 8,
    padding: "2px 8px",
  },

  okMsg: { fontSize: 13, fontWeight: 600, color: ACCENT, marginRight: "auto" },
  errMsgInline: { fontSize: 12.5, color: T.danger, marginRight: "auto", lineHeight: 1.5 },

  // list rows (shared)
  rows: { display: "flex", flexDirection: "column", gap: 8 },

  // unanswered
  qRow: {
    border: `1px solid ${T.border}`,
    borderRadius: 13,
    padding: "10px 12px",
    background: T.surface,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  qHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  qText: { flex: 1, minWidth: 0, fontSize: 14, color: T.fg, fontWeight: 600, wordBreak: "break-word" },
  askChip: {
    fontSize: 11,
    fontWeight: 700,
    color: T.warning,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 999,
    padding: "1px 8px",
  },
  qAnswerArea: { display: "flex", flexDirection: "column", gap: 8 },

  // entry card
  entryCard: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    border: `1px solid ${T.border}`,
    borderRadius: 13,
    padding: "11px 13px",
    background: T.surface,
  },
  entryMain: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
  entryQ: { fontSize: 14.5, fontWeight: 700, color: T.fg, lineHeight: 1.4, wordBreak: "break-word" },
  entryA: { fontSize: 13.5, color: T.muted, lineHeight: 1.55, wordBreak: "break-word", whiteSpace: "pre-wrap" },
  entryMeta: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 },
  sourceTag: {
    fontSize: 10.5,
    fontWeight: 700,
    color: ACCENT,
    background: T.successWeak,
    borderRadius: 6,
    padding: "1px 6px",
  },
  kwTag: { fontSize: 11, color: T.muted2, background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 6, padding: "1px 6px" },
  offTag: {
    fontSize: 10.5,
    fontWeight: 700,
    color: T.muted2,
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: "1px 6px",
  },
  entryActions: { flex: "0 0 auto", display: "flex", gap: 4, alignItems: "center" },
  editCard: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    border: `1px solid ${ACCENT}55`,
    borderRadius: 13,
    padding: "12px 13px",
    background: T.surface,
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
  miniGhost: {
    fontFamily: FONT,
    fontSize: 12.5,
    color: T.muted,
    background: "transparent",
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    padding: "6px 12px",
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
    fontSize: 13.5,
    lineHeight: 1.6,
    padding: "18px 8px",
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
