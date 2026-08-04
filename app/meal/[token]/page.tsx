"use client";

// หน้าเว็บจัดการอาหาร — เปิดจากลิงก์ที่บอทส่งให้ (`/meal/<token>`)
//
// โทเคนคือสิทธิ์ทั้งหมด และมันผูกกับ **(แชท × คน)** ไม่ใช่แค่แชท — ไดอารี่อาหารเป็นข้อมูล
// สุขภาพส่วนบุคคล คนอื่นในกลุ่มเดียวกันจึงเปิดของเราไม่ได้ (ดู lib/meal-token.ts)
//
// 2 แท็บ:
//   🍽️ ไดอารี่   — รายการที่กินรายวัน แก้ปริมาณ/มื้อ/ชื่ออาหารได้ในที่ · ลบ · กู้คืน
//   🥗 ฐานอาหาร  — ค้น/ดูค่าสารอาหารทั้งฐาน · แก้ · ลบ · เพิ่มเอง · **สั่งให้ AI เรียนรู้**
//
// ธีม: สีมาจาก `T` (../../ui-theme → CSS vars) จึงสลับ light/dark และสเกลตามการตั้งค่าฟอนต์
// ของแอปเอง. ไม่มีไลบรารีภายนอก — กราฟสัดส่วนวาดด้วย conic-gradient ล้วน

import { useCallback, useEffect, useMemo, useState } from "react";
import { T } from "../../ui-theme";

// ── types (ตรงกับ payload ของ API) ──────────────────────────────────────────────
type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

interface Entry {
  id: string;
  occurred_on: string;
  meal_slot: MealSlot;
  food_name: string;
  qty: number;
  qty_unit: "g" | "unit";
  grams: number | null;
  kcal: number;
  carb_g: number;
  protein_g: number;
  fat_g: number;
  resolved: boolean;
  food_source: string | null;
  raw_text: string | null;
}

interface Summary {
  total: { kcal: number; carbG: number; proteinG: number; fatG: number };
  split: { carbPct: number; proteinPct: number; fatPct: number };
  count: number;
  unresolvedNames: string[];
  aiNames: string[];
}

interface Food {
  id: string;
  tenant_id: string | null;
  name: string;
  aliases: string | null;
  basis: "per_100g" | "per_serving";
  unit_label: string | null;
  unit_grams: number | null;
  kcal: number;
  carb_g: number;
  protein_g: number;
  fat_g: number;
  source: string;
}

const SLOTS: { key: MealSlot; label: string; emoji: string }[] = [
  { key: "breakfast", label: "มื้อเช้า", emoji: "🌅" },
  { key: "lunch", label: "มื้อกลางวัน", emoji: "☀️" },
  { key: "dinner", label: "มื้อเย็น", emoji: "🌙" },
  { key: "snack", label: "ของว่าง", emoji: "🍪" },
];

const MACRO = { carb: "#F59E0B", protein: "#0EA47F", fat: "#8B5CF6" };

const THAI_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
const THAI_DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

function formatThaiDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${THAI_DOW[dt.getUTCDay()]} ${d} ${THAI_MONTHS[m - 1]} ${String((y + 543) % 100).padStart(2, "0")}`;
}

/** เลื่อนวันแบบไม่โดน timezone เล่นงาน (คำนวณบน UTC ล้วน) */
function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function bkkToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const g = (n: number): string => {
  const v = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
const kcal = (n: number): string => Math.round(Number(n)).toLocaleString("th-TH");

// ── page ────────────────────────────────────────────────────────────────────────
export default function MealPage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [tab, setTab] = useState<"diary" | "foods">("diary");
  const [date, setDate] = useState(bkkToday());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3200);
  }, []);

  const applyPayload = useCallback((d: { entries?: Entry[]; summary?: Summary }) => {
    setEntries(d.entries ?? []);
    setSummary(d.summary ?? null);
  }, []);

  const load = useCallback(
    async (ymd: string) => {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch(`/api/meal/${token}?date=${ymd}`);
        const d = await res.json();
        if (!res.ok || !d.ok) throw new Error(d.reason ?? `HTTP ${res.status}`);
        applyPayload(d);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "โหลดไม่สำเร็จ");
      } finally {
        setLoading(false);
      }
    },
    [token, applyPayload]
  );

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const mutate = useCallback(
    async (method: "PATCH" | "DELETE" | "POST", body: Record<string, unknown>, okMsg?: string) => {
      setBusy(String(body.id ?? body.action ?? "x"));
      try {
        const res = await fetch(`/api/meal/${token}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await res.json();
        if (!res.ok || !d.ok) throw new Error(d.reason ?? `HTTP ${res.status}`);
        applyPayload(d);
        if (d.occurredOn && d.occurredOn !== date) setDate(d.occurredOn);
        if (okMsg) flash(okMsg);
      } catch (e) {
        flash(`❌ ${e instanceof Error ? e.message : "ทำรายการไม่สำเร็จ"}`);
      } finally {
        setBusy(null);
      }
    },
    [token, date, applyPayload, flash]
  );

  const bySlot = useMemo(() => {
    // เลขกำกับต้องนับต่อเนื่องทั้งวันตามลำดับที่ API ส่งมา (= ลำดับเดียวกับที่บอทใช้)
    const numbered = entries.map((e, i) => ({ e, no: i + 1 }));
    return SLOTS.map((s) => ({
      ...s,
      rows: numbered.filter((n) => n.e.meal_slot === s.key),
    })).filter((s) => s.rows.length > 0);
  }, [entries]);

  return (
    <div className="meal-scope" style={sx.page}>
      <GlobalStyle />
      <div style={sx.shell}>
        <header className="meal-hero" style={sx.hero}>
          <div style={sx.heroTop}>
            <span style={sx.badge}>UP Line</span>
            <ThemeToggle />
          </div>
          <h1 style={sx.h1}>🍽️ อาหารของฉัน</h1>
          <p style={sx.heroSub}>
            แก้รายการที่บันทึกไว้ · ดูฐานข้อมูลอาหาร · สั่งให้ AI เรียนรู้อาหารใหม่ —
            ลิงก์นี้เป็นของคุณคนเดียว อย่าแชร์ต่อ
          </p>
        </header>

        <nav style={sx.tabs}>
          <button
            onClick={() => setTab("diary")}
            style={{ ...sx.tab, ...(tab === "diary" ? sx.tabOn : null) }}
          >
            🍽️ ไดอารี่
          </button>
          <button
            onClick={() => setTab("foods")}
            style={{ ...sx.tab, ...(tab === "foods" ? sx.tabOn : null) }}
          >
            🥗 ฐานอาหาร
          </button>
        </nav>

        {toast && <div style={sx.toast}>{toast}</div>}

        {tab === "diary" ? (
          <>
            <div style={sx.dateBar}>
              <button style={sx.navBtn} onClick={() => setDate(shiftDate(date, -1))}>
                ‹
              </button>
              <div style={sx.dateMid}>
                <div style={sx.dateText}>{formatThaiDate(date)}</div>
                {date !== bkkToday() && (
                  <button style={sx.todayBtn} onClick={() => setDate(bkkToday())}>
                    กลับไปวันนี้
                  </button>
                )}
              </div>
              <button
                style={{ ...sx.navBtn, opacity: date >= bkkToday() ? 0.35 : 1 }}
                disabled={date >= bkkToday()}
                onClick={() => setDate(shiftDate(date, 1))}
              >
                ›
              </button>
            </div>

            {loading ? (
              <div style={sx.empty}>กำลังโหลด…</div>
            ) : err ? (
              <div style={{ ...sx.empty, color: T.danger }}>{err}</div>
            ) : (
              <>
                {summary && summary.count > 0 && <SummaryCard s={summary} />}

                {bySlot.length === 0 ? (
                  <div style={sx.empty}>
                    ยังไม่มีบันทึกอาหารของวันนี้
                    <div style={sx.emptyHint}>
                      พิมพ์ในไลน์ได้เลย เช่น<br />
                      <code style={sx.code}>กิน เช้า</code>{" "}
                      <code style={sx.code}>ข้าวสวย 100g</code>
                    </div>
                  </div>
                ) : (
                  bySlot.map((s) => (
                    <section key={s.key} style={sx.card}>
                      <div style={sx.slotHead}>
                        <span style={sx.slotName}>
                          {s.emoji} {s.label}
                        </span>
                        <span style={sx.slotKcal}>
                          {kcal(s.rows.reduce((a, r) => a + Number(r.e.kcal), 0))} kcal
                        </span>
                      </div>
                      {s.rows.map(({ e, no }) => (
                        <EntryRow
                          key={e.id}
                          entry={e}
                          no={no}
                          busy={busy === e.id}
                          onSave={(patch) => mutate("PATCH", { id: e.id, ...patch }, "✅ แก้แล้ว")}
                          onDelete={() =>
                            mutate("DELETE", { id: e.id, occurredOn: date }, "🗑️ ลบแล้ว — กดกู้คืนได้")
                          }
                        />
                      ))}
                    </section>
                  ))
                )}

                <button
                  style={sx.restoreBtn}
                  disabled={busy === "restore"}
                  onClick={() => mutate("POST", { action: "restore" }, "♻️ กู้คืนแล้ว")}
                >
                  ♻️ กู้คืนรายการที่เพิ่งลบ
                </button>
              </>
            )}
          </>
        ) : (
          <FoodsTab token={token} flash={flash} />
        )}

        <footer style={sx.footer}>
          UP Line · บันทึกอาหาร — ตัวเลขเป็นค่าประมาณเพื่อดูแนวโน้ม ไม่ใช่คำแนะนำทางการแพทย์
        </footer>
      </div>
    </div>
  );
}

// ── สรุปวัน ─────────────────────────────────────────────────────────────────────
function SummaryCard({ s }: { s: Summary }) {
  const { split, total } = s;
  // conic-gradient = โดนัทจริงโดยไม่ต้องพึ่งไลบรารีกราฟหรือรูปจากเซิร์ฟเวอร์
  const c = split.carbPct;
  const p = split.proteinPct;
  const ring = `conic-gradient(${MACRO.carb} 0 ${c}%, ${MACRO.protein} ${c}% ${c + p}%, ${MACRO.fat} ${
    c + p
  }% 100%)`;

  return (
    <section className="meal-summary" style={{ ...sx.card, ...sx.summaryCard }}>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div style={{ ...sx.donut, background: total.kcal > 0 ? ring : T.surface2 }} />
        <div style={sx.donutHole}>
          <div style={sx.donutKcal}>{kcal(total.kcal)}</div>
          <div style={sx.donutUnit}>kcal</div>
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={sx.sumTitle}>รวมทั้งวัน · {s.count} รายการ</div>
        <MacroLine color={MACRO.carb} label="คาร์บ" grams={total.carbG} pct={split.carbPct} />
        <MacroLine color={MACRO.protein} label="โปรตีน" grams={total.proteinG} pct={split.proteinPct} />
        <MacroLine color={MACRO.fat} label="ไขมัน" grams={total.fatG} pct={split.fatPct} />
        {s.aiNames.length > 0 && (
          <div style={sx.aiNote}>🤖 ค่าประมาณจาก AI: {s.aiNames.join(", ")}</div>
        )}
        {s.unresolvedNames.length > 0 && (
          <div style={sx.warnNote}>
            ⚠️ ยังไม่รู้จัก: {s.unresolvedNames.join(", ")} — ยอดรวมยังไม่นับรายการนี้
          </div>
        )}
      </div>
    </section>
  );
}

function MacroLine({ color, label, grams, pct }: { color: string; label: string; grams: number; pct: number }) {
  return (
    <div style={sx.macroRow}>
      <span style={{ ...sx.dot, background: color }} />
      <span style={sx.macroLabel}>{label}</span>
      <span style={sx.macroBarWrap}>
        <span style={{ ...sx.macroBar, width: `${pct}%`, background: color }} />
      </span>
      <span style={sx.macroVal}>{g(grams)} g</span>
      <span style={sx.macroPct}>{pct}%</span>
    </div>
  );
}

// ── หนึ่งรายการในไดอารี่ (แก้ในที่ได้) ──────────────────────────────────────────
function EntryRow({
  entry,
  no,
  busy,
  onSave,
  onDelete,
}: {
  entry: Entry;
  no: number;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(entry.food_name);
  const [qty, setQty] = useState(String(entry.qty));
  const [unit, setUnit] = useState<Entry["qty_unit"]>(entry.qty_unit);
  const [slot, setSlot] = useState<MealSlot>(entry.meal_slot);

  // ค่าจากเซิร์ฟเวอร์เปลี่ยน (เช่นหลังบันทึก) → sync ฟอร์มตาม ไม่งั้นจะค้างค่าเก่า
  useEffect(() => {
    setName(entry.food_name);
    setQty(String(entry.qty));
    setUnit(entry.qty_unit);
    setSlot(entry.meal_slot);
  }, [entry.food_name, entry.qty, entry.qty_unit, entry.meal_slot]);

  const dirty =
    name.trim() !== entry.food_name ||
    Number(qty) !== Number(entry.qty) ||
    unit !== entry.qty_unit ||
    slot !== entry.meal_slot;

  const qtyLabel = entry.qty_unit === "g" ? `${g(entry.qty)} g` : `${g(entry.qty)} หน่วย`;

  return (
    <div style={sx.entry}>
      <div style={sx.entryMain} onClick={() => setOpen((v) => !v)}>
        <span style={sx.entryNo}>{no}.</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...sx.entryName, color: entry.resolved ? T.fgStrong : T.muted }}>
            {entry.food_source === "ai-estimate" && <span title="ค่าประมาณจาก AI">🤖 </span>}
            {entry.food_name}
            {!entry.resolved && <span style={sx.unknownTag}>ยังไม่รู้จัก</span>}
          </div>
          <div style={sx.entryMeta}>
            {qtyLabel}
            {entry.grams !== null && ` ≈ ${g(entry.grams)} g`} · C {g(entry.carb_g)} · P{" "}
            {g(entry.protein_g)} · F {g(entry.fat_g)}
          </div>
        </div>
        <div style={sx.entryKcal}>{kcal(entry.kcal)}</div>
        <span style={{ ...sx.chev, transform: open ? "rotate(90deg)" : "none" }}>›</span>
      </div>

      {open && (
        <div style={sx.editBox}>
          <label style={sx.field}>
            <span style={sx.fieldLabel}>ชื่ออาหาร</span>
            <input style={sx.input} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="meal-fieldrow" style={sx.fieldRow}>
            <label style={{ ...sx.field, flex: 1 }}>
              <span style={sx.fieldLabel}>ปริมาณ</span>
              <input
                style={sx.input}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </label>
            <label style={{ ...sx.field, flex: 1 }}>
              <span style={sx.fieldLabel}>หน่วย</span>
              <select style={sx.input} value={unit} onChange={(e) => setUnit(e.target.value as Entry["qty_unit"])}>
                <option value="unit">จาน/ชิ้น/ที่</option>
                <option value="g">กรัม</option>
              </select>
            </label>
            <label style={{ ...sx.field, flex: 1.2 }}>
              <span style={sx.fieldLabel}>มื้อ</span>
              <select style={sx.input} value={slot} onChange={(e) => setSlot(e.target.value as MealSlot)}>
                {SLOTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={sx.editActions}>
            <button
              style={{ ...sx.saveBtn, opacity: dirty && !busy ? 1 : 0.45 }}
              disabled={!dirty || busy}
              onClick={() =>
                onSave({
                  foodName: name.trim(),
                  qty: Number(qty),
                  qtyUnit: unit,
                  mealSlot: slot,
                })
              }
            >
              {busy ? "กำลังบันทึก…" : "💾 บันทึก"}
            </button>
            <button style={sx.delBtn} disabled={busy} onClick={onDelete}>
              🗑️ ลบ
            </button>
          </div>
          <div style={sx.editHint}>
            เปลี่ยนชื่ออาหารแล้วระบบจะจับคู่กับฐานใหม่และคำนวณสารอาหารให้อัตโนมัติ
          </div>
        </div>
      )}
    </div>
  );
}

// ── แท็บฐานอาหาร ────────────────────────────────────────────────────────────────
function FoodsTab({ token, flash }: { token: string; flash: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [foods, setFoods] = useState<Food[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [learnName, setLearnName] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(
    async (term: string) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/meal/${token}/foods?q=${encodeURIComponent(term)}`);
        const d = await res.json();
        if (!res.ok || !d.ok) throw new Error(d.reason ?? `HTTP ${res.status}`);
        setFoods(d.foods ?? []);
        setAiEnabled(Boolean(d.aiEnabled));
      } catch (e) {
        flash(`❌ ${e instanceof Error ? e.message : "โหลดฐานอาหารไม่สำเร็จ"}`);
      } finally {
        setLoading(false);
      }
    },
    [token, flash]
  );

  // debounce การค้น — ผู้ใช้พิมพ์ไทยทีละตัว ยิงทุกคีย์จะถี่เกินไป
  useEffect(() => {
    const t = setTimeout(() => void load(q), 280);
    return () => clearTimeout(t);
  }, [q, load]);

  const learn = async () => {
    const name = learnName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/meal/${token}/foods`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, learn: true }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        // ai_rejected = ผ่านด่านตรวจไม่ได้ (ไม่ใช่อาหาร/ไม่มั่นใจ/ค่าเพี้ยน) — บอกให้กรอกเอง
        throw new Error(
          d.reason === "ai_rejected"
            ? "AI ไม่มั่นใจกับรายการนี้ (อาจไม่ใช่อาหาร หรือข้อมูลไม่พอ) — กรอกเองได้ด้านล่าง"
            : d.reason === "ai_disabled"
              ? "ยังไม่ได้เปิดใช้ AI"
              : (d.reason ?? `HTTP ${res.status}`)
        );
      }
      flash(`🤖 เรียนรู้แล้ว: ${d.food.name} (ความมั่นใจ ${Math.round((d.confidence ?? 0) * 100)}%)`);
      setLearnName("");
      await load(q);
    } catch (e) {
      flash(`❌ ${e instanceof Error ? e.message : "เรียนรู้ไม่สำเร็จ"}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: Food) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/meal/${token}/foods`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: f.id }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.reason ?? `HTTP ${res.status}`);
      flash(`🗑️ ลบ ${f.name} แล้ว`);
      await load(q);
    } catch (e) {
      flash(`❌ ${e instanceof Error ? e.message : "ลบไม่สำเร็จ"}`);
    } finally {
      setBusy(false);
    }
  };

  const mine = foods.filter((f) => f.tenant_id !== null);
  const shared = foods.filter((f) => f.tenant_id === null);

  return (
    <>
      <section style={sx.card}>
        <div style={sx.learnHead}>🤖 สั่งให้ AI เรียนรู้อาหารใหม่</div>
        <div style={sx.learnRow}>
          <input
            style={{ ...sx.input, flex: 1 }}
            placeholder="เช่น ก๋วยจั๊บน้ำข้น, ข้าวหน้าเนื้อ"
            value={learnName}
            onChange={(e) => setLearnName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void learn()}
          />
          <button
            style={{ ...sx.learnBtn, opacity: busy || !learnName.trim() || !aiEnabled ? 0.5 : 1 }}
            disabled={busy || !learnName.trim() || !aiEnabled}
            onClick={() => void learn()}
          >
            {busy ? "…" : "เรียนรู้"}
          </button>
        </div>
        <div style={sx.learnHint}>
          {aiEnabled
            ? "AI จะประเมินค่าสารอาหารแล้วเก็บเข้าฐานของคุณ — เป็นค่าประมาณ แก้ทับได้ทุกเมื่อ"
            : "ยังไม่ได้เปิดใช้ AI — เพิ่มเองได้ด้านล่าง"}
        </div>
        <button style={sx.addToggle} onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "▾ ปิดฟอร์มเพิ่มเอง" : "▸ เพิ่มเอง (กรอกค่าสารอาหารเอง)"}
        </button>
        {showAdd && (
          <AddFoodForm
            token={token}
            flash={flash}
            onDone={async () => {
              setShowAdd(false);
              await load(q);
            }}
          />
        )}
      </section>

      <input
        style={{ ...sx.input, width: "100%" }}
        placeholder="🔍 ค้นหาอาหารในฐาน…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {loading ? (
        <div style={sx.empty}>กำลังโหลด…</div>
      ) : foods.length === 0 ? (
        <div style={sx.empty}>ไม่พบอาหารที่ตรงกับ “{q}”</div>
      ) : (
        <>
          {mine.length > 0 && (
            <section style={sx.card}>
              <div style={sx.slotHead}>
                <span style={sx.slotName}>🏷️ ของธุรกิจคุณ</span>
                <span style={sx.slotKcal}>{mine.length} รายการ</span>
              </div>
              {mine.map((f) => (
                <FoodRow key={f.id} food={f} onDelete={() => void remove(f)} busy={busy} />
              ))}
            </section>
          )}
          {shared.length > 0 && (
            <section style={sx.card}>
              <div style={sx.slotHead}>
                <span style={sx.slotName}>📚 ฐานกลาง (ใช้ร่วมกัน)</span>
                <span style={sx.slotKcal}>{shared.length} รายการ</span>
              </div>
              {shared.map((f) => (
                <FoodRow key={f.id} food={f} busy={busy} />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

function FoodRow({ food, onDelete, busy }: { food: Food; onDelete?: () => void; busy: boolean }) {
  const basis =
    food.basis === "per_100g"
      ? "ต่อ 100 g"
      : `ต่อ 1 ${food.unit_label ?? "ที่"}${food.unit_grams ? ` (≈${g(food.unit_grams)} g)` : ""}`;
  return (
    <div style={sx.foodRow}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={sx.entryName}>
          {food.source === "ai-estimate" && <span title="ค่าประมาณจาก AI">🤖 </span>}
          {food.name}
        </div>
        <div style={sx.entryMeta}>
          {basis} · C {g(food.carb_g)} · P {g(food.protein_g)} · F {g(food.fat_g)}
          {food.aliases && ` · เรียกอีกอย่าง: ${food.aliases}`}
        </div>
      </div>
      <div style={sx.entryKcal}>{kcal(food.kcal)}</div>
      {onDelete && (
        <button style={sx.rowDel} disabled={busy} onClick={onDelete} title="ลบออกจากฐาน">
          ✕
        </button>
      )}
    </div>
  );
}

function AddFoodForm({
  token,
  flash,
  onDone,
}: {
  token: string;
  flash: (m: string) => void;
  onDone: () => Promise<void>;
}) {
  const [f, setF] = useState({
    name: "",
    carbG: "",
    proteinG: "",
    fatG: "",
    basis: "per_serving" as Food["basis"],
    unitLabel: "จาน",
    unitGrams: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/meal/${token}/foods`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: f.name.trim(),
          carbG: Number(f.carbG || 0),
          proteinG: Number(f.proteinG || 0),
          fatG: Number(f.fatG || 0),
          basis: f.basis,
          unitLabel: f.basis === "per_serving" ? f.unitLabel : null,
          unitGrams: f.unitGrams ? Number(f.unitGrams) : null,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.reason ?? `HTTP ${res.status}`);
      flash(`✅ บันทึก ${d.food.name} แล้ว (${kcal(d.food.kcal)} kcal)`);
      setF({ ...f, name: "", carbG: "", proteinG: "", fatG: "", unitGrams: "" });
      await onDone();
    } catch (e) {
      flash(`❌ ${e instanceof Error ? e.message : "บันทึกไม่สำเร็จ"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={sx.addForm}>
      <label style={sx.field}>
        <span style={sx.fieldLabel}>ชื่ออาหาร</span>
        <input style={sx.input} value={f.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <div className="meal-fieldrow" style={sx.fieldRow}>
        {(["carbG", "proteinG", "fatG"] as const).map((k, i) => (
          <label key={k} style={{ ...sx.field, flex: 1 }}>
            <span style={sx.fieldLabel}>{["คาร์บ (g)", "โปรตีน (g)", "ไขมัน (g)"][i]}</span>
            <input
              style={sx.input}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={f[k]}
              onChange={(e) => set(k, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="meal-fieldrow" style={sx.fieldRow}>
        <label style={{ ...sx.field, flex: 1.4 }}>
          <span style={sx.fieldLabel}>คิดค่าต่อ</span>
          <select
            style={sx.input}
            value={f.basis}
            onChange={(e) => set("basis", e.target.value as Food["basis"])}
          >
            <option value="per_serving">1 หน่วยเสิร์ฟ</option>
            <option value="per_100g">100 กรัม</option>
          </select>
        </label>
        {f.basis === "per_serving" && (
          <label style={{ ...sx.field, flex: 1 }}>
            <span style={sx.fieldLabel}>หน่วย</span>
            <input style={sx.input} value={f.unitLabel} onChange={(e) => set("unitLabel", e.target.value)} />
          </label>
        )}
        <label style={{ ...sx.field, flex: 1 }}>
          <span style={sx.fieldLabel}>น้ำหนัก/หน่วย (g)</span>
          <input
            style={sx.input}
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={f.unitGrams}
            onChange={(e) => set("unitGrams", e.target.value)}
          />
        </label>
      </div>
      <button
        style={{ ...sx.saveBtn, opacity: busy || !f.name.trim() ? 0.5 : 1 }}
        disabled={busy || !f.name.trim()}
        onClick={() => void submit()}
      >
        {busy ? "กำลังบันทึก…" : "💾 เพิ่มเข้าฐาน"}
      </button>
      <div style={sx.editHint}>
        พลังงานคำนวณจากสารอาหารให้อัตโนมัติ (คาร์บ·โปรตีน 4 · ไขมัน 9 kcal ต่อกรัม)
      </div>
    </div>
  );
}

// ── ปุ่มสลับธีม ─────────────────────────────────────────────────────────────────
function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const stored = root.getAttribute("data-theme");
    setDark(stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
  };

  return (
    <button style={sx.themeBtn} onClick={toggle} title="สลับโหมดสว่าง/มืด">
      {dark ? "☀️" : "🌙"}
    </button>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────
function GlobalStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        html,body{margin:0;padding:0;background:${T.bg};}
        *{box-sizing:border-box;}
        .meal-scope input,.meal-scope select,.meal-scope button{font-family:inherit;font-size:inherit;}
        .meal-scope input:focus,.meal-scope select:focus{outline:2px solid ${T.ring};outline-offset:1px;}
        .meal-scope ::-webkit-scrollbar{width:9px;height:9px;}
        .meal-scope ::-webkit-scrollbar-thumb{background:${T.borderStrong};border-radius:8px;}
        /* มือถือ (เบราว์เซอร์ในไลน์ ~375–430px): บีบระยะ ย่อ hero และให้ฟอร์มเรียงลงแทนเรียงข้าง */
        @media (max-width:560px){
          .meal-scope{padding:16px 12px 48px !important;}
          .meal-hero{padding:20px 18px !important;border-radius:18px !important;}
          .meal-hero h1{font-size:23px !important;}
          .meal-summary{flex-direction:column !important;align-items:center !important;text-align:left;}
          .meal-fieldrow{flex-direction:column !important;gap:10px !important;}
        }
      `,
      }}
    />
  );
}

const FONT = "var(--font-sans)";

const sx: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: T.bg,
    backgroundImage: "var(--bg-tint)",
    padding: "28px 20px 64px",
    fontFamily: FONT,
    color: T.fg,
    // ภาษาไทยต้องการระยะบรรทัดมากกว่า default ของเว็บทั่วไป ไม่งั้นวรรณยุกต์ชนกัน
    lineHeight: 1.8,
  },
  shell: { maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 },

  hero: {
    background: T.surfaceGlass,
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusLg,
    padding: "26px 24px",
    boxShadow: T.shadowMd,
  },
  heroTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  badge: {
    display: "inline-block",
    padding: "3px 11px",
    borderRadius: T.radiusPill,
    background: T.accentWeak,
    color: T.accent,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.4,
  },
  themeBtn: {
    border: `1px solid ${T.border}`,
    background: T.surface,
    color: T.fg,
    borderRadius: T.radiusPill,
    width: 36,
    height: 36,
    cursor: "pointer",
    fontSize: 15,
  },
  h1: { margin: "14px 0 0", fontSize: 27, fontWeight: 800, color: T.fgStrong, letterSpacing: -0.3 },
  heroSub: { margin: "8px 0 0", color: T.muted, fontSize: 14.5, lineHeight: 1.75, maxWidth: 520 },

  tabs: { display: "flex", gap: 8 },
  tab: {
    flex: 1,
    padding: "11px 14px",
    borderRadius: T.radius,
    border: `1px solid ${T.border}`,
    background: T.surface,
    color: T.muted,
    fontWeight: 600,
    fontSize: 15,
    cursor: "pointer",
  },
  tabOn: {
    background: T.accent,
    color: T.accentFg,
    borderColor: T.accent,
    boxShadow: T.shadowSm,
  },

  toast: {
    background: T.surface,
    border: `1px solid ${T.borderStrong}`,
    borderRadius: T.radius,
    padding: "11px 15px",
    fontSize: 14.5,
    color: T.fgStrong,
    boxShadow: T.shadowMd,
  },

  dateBar: { display: "flex", alignItems: "center", gap: 10 },
  navBtn: {
    width: 42,
    height: 42,
    borderRadius: T.radius,
    border: `1px solid ${T.border}`,
    background: T.surface,
    color: T.fg,
    fontSize: 21,
    cursor: "pointer",
    lineHeight: 1,
  },
  dateMid: { flex: 1, textAlign: "center" },
  dateText: { fontSize: 16.5, fontWeight: 700, color: T.fgStrong },
  todayBtn: {
    marginTop: 2,
    border: "none",
    background: "none",
    color: T.accent,
    fontSize: 13,
    cursor: "pointer",
    textDecoration: "underline",
  },

  card: {
    background: T.surface,
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusLg,
    padding: "16px 18px",
    boxShadow: T.shadowSm,
  },
  summaryCard: { display: "flex", gap: 20, alignItems: "center" },

  donut: { width: 116, height: 116, borderRadius: "50%" },
  donutHole: {
    position: "absolute",
    inset: 17,
    borderRadius: "50%",
    background: T.surface,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1.15,
  },
  donutKcal: { fontSize: 21, fontWeight: 800, color: T.fgStrong },
  donutUnit: { fontSize: 11.5, color: T.muted },

  sumTitle: { fontSize: 14, color: T.muted, marginBottom: 8, fontWeight: 600 },
  macroRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 7 },
  dot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  macroLabel: { fontSize: 14, color: T.fg, width: 52, flexShrink: 0 },
  macroBarWrap: {
    flex: 1,
    height: 7,
    background: T.surface2,
    borderRadius: 4,
    overflow: "hidden",
    minWidth: 30,
  },
  macroBar: { display: "block", height: "100%", borderRadius: 4 },
  macroVal: { fontSize: 13.5, fontWeight: 700, color: T.fgStrong, width: 58, textAlign: "right" },
  macroPct: { fontSize: 13, color: T.muted, width: 38, textAlign: "right" },

  aiNote: { marginTop: 11, fontSize: 13.5, color: T.primary, lineHeight: 1.7 },
  warnNote: { marginTop: 7, fontSize: 13.5, color: T.warning, lineHeight: 1.7 },

  slotHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingBottom: 9,
    borderBottom: `1px solid ${T.border}`,
  },
  slotName: { fontSize: 15.5, fontWeight: 700, color: T.fgStrong },
  slotKcal: { fontSize: 13.5, color: T.muted },

  entry: { borderBottom: `1px solid ${T.border}` },
  entryMain: { display: "flex", alignItems: "center", gap: 10, padding: "12px 0", cursor: "pointer" },
  entryNo: { fontSize: 13, color: T.muted2, width: 20, flexShrink: 0 },
  entryName: { fontSize: 15, fontWeight: 600, color: T.fgStrong, lineHeight: 1.55 },
  unknownTag: { marginLeft: 6, fontSize: 12, color: T.warning, fontWeight: 500 },
  entryMeta: { fontSize: 13, color: T.muted, lineHeight: 1.65, marginTop: 1 },
  entryKcal: { fontSize: 15, fontWeight: 700, color: T.fgStrong, flexShrink: 0 },
  chev: { color: T.muted2, fontSize: 19, transition: "transform .15s", flexShrink: 0, width: 12 },

  editBox: { padding: "4px 0 16px", display: "flex", flexDirection: "column", gap: 11 },
  field: { display: "flex", flexDirection: "column", gap: 5 },
  fieldLabel: { fontSize: 12.5, color: T.muted, fontWeight: 600 },
  fieldRow: { display: "flex", gap: 9 },
  input: {
    padding: "10px 12px",
    borderRadius: T.radiusSm,
    border: `1px solid ${T.borderStrong}`,
    background: T.surface,
    color: T.fg,
    fontSize: 15,
    width: "100%",
    minWidth: 0,
  },
  editActions: { display: "flex", gap: 9 },
  saveBtn: {
    flex: 1,
    padding: "11px 16px",
    borderRadius: T.radius,
    border: "none",
    background: T.accent,
    color: T.accentFg,
    fontWeight: 700,
    fontSize: 15,
    cursor: "pointer",
  },
  delBtn: {
    padding: "11px 16px",
    borderRadius: T.radius,
    border: `1px solid ${T.border}`,
    background: T.dangerWeak,
    color: T.danger,
    fontWeight: 600,
    fontSize: 15,
    cursor: "pointer",
  },
  editHint: { fontSize: 12.5, color: T.muted, lineHeight: 1.7 },

  restoreBtn: {
    padding: "12px 16px",
    borderRadius: T.radius,
    border: `1px dashed ${T.borderStrong}`,
    background: "transparent",
    color: T.muted,
    fontSize: 14.5,
    cursor: "pointer",
  },

  learnHead: { fontSize: 15.5, fontWeight: 700, color: T.fgStrong, marginBottom: 10 },
  learnRow: { display: "flex", gap: 9 },
  learnBtn: {
    padding: "10px 20px",
    borderRadius: T.radiusSm,
    border: "none",
    background: T.primary,
    color: T.primaryFg,
    fontWeight: 700,
    fontSize: 15,
    cursor: "pointer",
    flexShrink: 0,
  },
  learnHint: { marginTop: 9, fontSize: 13, color: T.muted, lineHeight: 1.7 },
  addToggle: {
    marginTop: 12,
    border: "none",
    background: "none",
    color: T.accent,
    fontSize: 14,
    cursor: "pointer",
    padding: 0,
    textAlign: "left",
  },
  addForm: {
    marginTop: 13,
    paddingTop: 14,
    borderTop: `1px solid ${T.border}`,
    display: "flex",
    flexDirection: "column",
    gap: 11,
  },

  foodRow: { display: "flex", alignItems: "center", gap: 11, padding: "11px 0", borderBottom: `1px solid ${T.border}` },
  rowDel: {
    border: `1px solid ${T.border}`,
    background: "transparent",
    color: T.muted2,
    borderRadius: T.radiusSm,
    width: 30,
    height: 30,
    cursor: "pointer",
    flexShrink: 0,
    fontSize: 14,
  },

  empty: {
    background: T.surface,
    border: `1px dashed ${T.borderStrong}`,
    borderRadius: T.radiusLg,
    padding: "34px 22px",
    textAlign: "center",
    color: T.muted,
    fontSize: 15,
  },
  emptyHint: { marginTop: 11, fontSize: 13.5, lineHeight: 2 },
  code: {
    background: T.surface2,
    padding: "3px 8px",
    borderRadius: 6,
    fontSize: 13,
    color: T.fgStrong,
  },

  footer: { marginTop: 6, textAlign: "center", fontSize: 12.5, color: T.muted2, lineHeight: 1.75 },
};
