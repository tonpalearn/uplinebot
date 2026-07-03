"use client";

import { useEffect, useMemo, useState } from "react";
import { T } from "../ui-theme";

type Cycle = "monthly" | "yearly";
type PlanKey = "starter" | "pro" | "business";

const PLANS: { key: PlanKey; name: string; monthly: number; tagline: string }[] = [
  { key: "starter", name: "Starter", monthly: 990, tagline: "เริ่มต้นให้ LINE ทำงานเอง" },
  { key: "pro", name: "Pro", monthly: 2990, tagline: "ครบสำหรับร้านที่ขายจริงจัง" },
  { key: "business", name: "Business", monthly: 4990, tagline: "ครบทุกโมดูล + งานหลังบ้าน" },
];

const baht = (n: number) => "฿" + n.toLocaleString("th-TH");

interface Sub {
  id: string;
  plan_key: PlanKey;
  billing_cycle: Cycle;
  status: string;
  amount: number;
  payment_ref: string;
  manage_token: string;
  current_period_end: string | null;
}
interface Qr {
  svg: string;
  payload: string;
  promptpay_id: string;
}

export default function SubscribePage() {
  const [plan, setPlan] = useState<PlanKey>("pro");
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [form, setForm] = useState({ business_name: "", customer_name: "", customer_email: "", customer_phone: "", line_oa_id: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sub: Sub; qr: Qr | null } | null>(null);

  // read ?plan=&cycle= from URL without useSearchParams (avoids Suspense requirement)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const qp = p.get("plan");
    const qc = p.get("cycle");
    if (qp === "starter" || qp === "pro" || qp === "business") setPlan(qp);
    if (qc === "monthly" || qc === "yearly") setCycle(qc);
  }, []);

  const selected = PLANS.find((p) => p.key === plan)!;
  const yearly = cycle === "yearly";
  const amount = useMemo(() => (yearly ? selected.monthly * 10 : selected.monthly), [selected, yearly]);
  const perMonth = yearly ? Math.round((selected.monthly * 10) / 12) : selected.monthly;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, cycle, ...form }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.reason || "สมัครไม่สำเร็จ");
      setResult({ sub: json.subscription, qr: json.qr });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "สมัครไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main style={{ minHeight: "100dvh", padding: "clamp(20px,4vw,44px) 20px 80px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <a href="/" style={{ color: T.muted, fontSize: "0.9rem", fontWeight: 600 }}>← กลับหน้าหลัก</a>

        {result ? (
          <PayView sub={result.sub} qr={result.qr} />
        ) : (
          <>
            <h1 style={{ fontSize: "clamp(1.5rem,3vw,2rem)", marginTop: 14 }}>สมัครใช้งาน UP Line</h1>
            <p style={{ color: T.muted, marginTop: 8, marginBottom: 24 }}>
              เลือกแพ็กเกจและรอบการชำระเงิน กรอกข้อมูลร้าน แล้วชำระผ่าน PromptPay ได้ทันที
            </p>

            {/* plan picker */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 14 }}>
              {PLANS.map((p) => {
                const active = p.key === plan;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPlan(p.key)}
                    style={{
                      textAlign: "left",
                      padding: 14,
                      borderRadius: T.radius,
                      border: `1.5px solid ${active ? T.primary : T.border}`,
                      background: active ? T.primaryWeak : T.surface,
                      boxShadow: active ? T.shadowSm : "none",
                      transition: "all .15s ease",
                    }}
                  >
                    <div style={{ fontWeight: 800, color: T.fgStrong }}>{p.name}</div>
                    <div style={{ fontSize: "0.75rem", color: T.muted, marginTop: 2, lineHeight: 1.4 }}>{p.tagline}</div>
                    <div style={{ fontWeight: 800, color: T.primary, marginTop: 8 }}>{baht(p.monthly)}<span style={{ fontSize: "0.7rem", color: T.muted, fontWeight: 600 }}>/ด.</span></div>
                  </button>
                );
              })}
            </div>

            {/* cycle toggle */}
            <div style={{ display: "inline-flex", gap: 4, padding: 5, borderRadius: 999, background: T.surface2, border: `1px solid ${T.border}`, marginBottom: 22 }}>
              {(["monthly", "yearly"] as Cycle[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCycle(c)}
                  style={{
                    border: "none",
                    background: cycle === c ? T.surface : "transparent",
                    color: cycle === c ? T.fgStrong : T.muted,
                    fontWeight: 700,
                    fontSize: "0.88rem",
                    padding: "8px 16px",
                    borderRadius: 999,
                    boxShadow: cycle === c ? T.shadowSm : "none",
                  }}
                >
                  {c === "monthly" ? "รายเดือน" : "รายปี (ฟรี 2 เดือน)"}
                </button>
              ))}
            </div>

            {/* summary bar */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: 16, borderRadius: T.radius, background: T.surface, border: `1px solid ${T.border}`, marginBottom: 22 }}>
              <div>
                <div style={{ fontWeight: 800, color: T.fgStrong }}>{selected.name} · {yearly ? "รายปี" : "รายเดือน"}</div>
                <div style={{ fontSize: "0.8rem", color: T.muted }}>
                  {yearly ? `${baht(amount)}/ปี · เท่ากับ ${baht(perMonth)}/เดือน` : "เก็บรายเดือน ยกเลิกได้ทุกเมื่อ"}
                </div>
              </div>
              <div style={{ fontSize: "1.5rem", fontWeight: 800, color: T.primary, whiteSpace: "nowrap" }}>{baht(amount)}</div>
            </div>

            {/* form */}
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label="ชื่อร้าน / ธุรกิจ *" value={form.business_name} onChange={(v) => setForm({ ...form, business_name: v })} placeholder="เช่น ร้านกาแฟ Sunrise" required />
              <Field label="ชื่อผู้ติดต่อ *" value={form.customer_name} onChange={(v) => setForm({ ...form, customer_name: v })} placeholder="ชื่อ-นามสกุล" required />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="อีเมล *" type="email" value={form.customer_email} onChange={(v) => setForm({ ...form, customer_email: v })} placeholder="you@email.com" required />
                <Field label="เบอร์โทร" value={form.customer_phone} onChange={(v) => setForm({ ...form, customer_phone: v })} placeholder="08x-xxx-xxxx" />
              </div>
              <Field label="LINE OA ID (ถ้ามี)" value={form.line_oa_id} onChange={(v) => setForm({ ...form, line_oa_id: v })} placeholder="@yourshop — ใส่ทีหลังก็ได้" />

              {error && <div style={{ color: T.danger, background: T.dangerWeak, padding: "10px 14px", borderRadius: 10, fontSize: "0.88rem" }}>{error}</div>}

              <button
                type="submit"
                disabled={submitting}
                style={{
                  marginTop: 6,
                  padding: "14px 20px",
                  borderRadius: T.radius,
                  border: "none",
                  background: T.accent,
                  color: T.accentFg,
                  fontWeight: 800,
                  fontSize: "1rem",
                  opacity: submitting ? 0.65 : 1,
                  boxShadow: T.shadowPrimary,
                }}
              >
                {submitting ? "กำลังสร้างรายการ..." : `ดำเนินการชำระเงิน ${baht(amount)}`}
              </button>
              <p style={{ fontSize: "0.78rem", color: T.muted2, textAlign: "center" }}>
                กด "ดำเนินการชำระเงิน" = ยอมรับเงื่อนไขการใช้งาน · ยังไม่มีการตัดเงินอัตโนมัติ
              </p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

/* ---------- payment view ---------- */
function PayView({ sub, qr }: { sub: Sub; qr: Qr | null }) {
  const manageUrl = `/account?token=${encodeURIComponent(sub.manage_token)}`;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: T.success, background: T.successWeak, padding: "6px 12px", borderRadius: 999, fontWeight: 700, fontSize: "0.85rem" }}>
        ● สร้างรายการแล้ว · รอชำระเงิน
      </div>
      <h1 style={{ fontSize: "clamp(1.4rem,3vw,1.9rem)", marginTop: 14 }}>ชำระเงินเพื่อเปิดใช้งาน</h1>
      <p style={{ color: T.muted, marginTop: 8 }}>
        แพ็กเกจ <b style={{ color: T.fgStrong }}>{sub.plan_key.toUpperCase()}</b> · {sub.billing_cycle === "yearly" ? "รายปี" : "รายเดือน"} · เลขอ้างอิง <b style={{ color: T.fgStrong }}>{sub.payment_ref}</b>
      </p>

      <div style={{ display: "grid", gridTemplateColumns: qr ? "auto 1fr" : "1fr", gap: 22, alignItems: "center", marginTop: 22, padding: 22, borderRadius: T.radius, background: T.surface, border: `1px solid ${T.border}` }}>
        {qr && (
          <div style={{ background: "#fff", padding: 12, borderRadius: 14, width: 200, height: 200, display: "grid", placeItems: "center" }} dangerouslySetInnerHTML={{ __html: qr.svg }} />
        )}
        <div>
          <div style={{ fontSize: "0.85rem", color: T.muted }}>ยอดชำระ</div>
          <div style={{ fontSize: "2.2rem", fontWeight: 800, color: T.primary, letterSpacing: "-0.02em" }}>{baht(sub.amount)}</div>
          {qr ? (
            <p style={{ color: T.muted, fontSize: "0.9rem", marginTop: 8, lineHeight: 1.6 }}>
              สแกน QR ด้วยแอปธนาคารเพื่อจ่ายผ่าน <b style={{ color: T.fgStrong }}>PromptPay</b><br />
              จ่ายแล้วเก็บสลิปไว้ ทีมงานยืนยันและเปิดใช้งานให้ภายใน 1 ชม.ทำการ
            </p>
          ) : (
            <p style={{ color: T.muted, fontSize: "0.9rem", marginTop: 8, lineHeight: 1.6 }}>
              ทีมงานจะติดต่อกลับทางอีเมลพร้อมช่องทางชำระเงิน (PromptPay / โอนธนาคาร) และเปิดใช้งานให้
            </p>
          )}
        </div>
      </div>

      <div style={{ marginTop: 18, padding: 16, borderRadius: T.radius, background: T.primaryWeak, border: `1px solid ${T.border}` }}>
        <div style={{ fontWeight: 700, color: T.fgStrong, marginBottom: 4 }}>เก็บลิงก์นี้ไว้จัดการสมาชิก</div>
        <p style={{ fontSize: "0.85rem", color: T.muted, marginBottom: 10 }}>ใช้ตรวจสถานะ ต่ออายุ หรือยกเลิกได้ทุกเมื่อ (ลิงก์นี้คือกุญแจ อย่าเผยแพร่)</p>
        <a href={manageUrl} style={{ display: "inline-block", padding: "10px 18px", borderRadius: 10, background: T.primary, color: T.primaryFg, fontWeight: 700, fontSize: "0.9rem" }}>
          ไปหน้าจัดการสมาชิก →
        </a>
      </div>
    </div>
  );
}

/* ---------- field ---------- */
function Field({ label, value, onChange, placeholder, type = "text", required }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; required?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: "0.82rem", fontWeight: 700, color: T.fg }}>{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "12px 14px",
          borderRadius: 11,
          border: `1px solid ${T.border}`,
          background: T.surface2,
          color: T.fg,
          fontSize: "0.95rem",
          outline: "none",
        }}
      />
    </label>
  );
}
