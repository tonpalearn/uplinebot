"use client";

import { useEffect, useState } from "react";
import { T } from "../ui-theme";
import SlipUpload from "../subscribe/SlipUpload";

const baht = (n: number) => "฿" + n.toLocaleString("th-TH");

interface Sub {
  id: string;
  plan_key: string;
  billing_cycle: string;
  status: "pending" | "active" | "canceled" | "past_due";
  business_name: string;
  customer_name: string;
  customer_email: string;
  amount: number;
  payment_ref: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  manage_token: string;
}
interface Qr { svg: string }

const STATUS_META: Record<Sub["status"], { label: string; color: string; weak: string }> = {
  pending: { label: "รอชำระเงิน", color: T.warning, weak: "var(--surface-2)" },
  active: { label: "ใช้งานอยู่", color: T.success, weak: T.successWeak },
  canceled: { label: "ยกเลิกแล้ว", color: T.muted2, weak: "var(--surface-2)" },
  past_due: { label: "ค้างชำระ", color: T.danger, weak: T.dangerWeak },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
}

export default function AccountPage() {
  const [token, setToken] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub | null>(null);
  const [qr, setQr] = useState<Qr | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    setToken(t);
    if (!t) {
      setLoading(false);
      setError("ไม่พบลิงก์จัดการสมาชิก (ต้องมี ?token= ในลิงก์)");
      return;
    }
    load(t);
  }, []);

  async function load(t: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/subscribe?token=${encodeURIComponent(t)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.reason === "not_found" ? "ไม่พบสมาชิกจากลิงก์นี้" : json.reason);
      setSub(json.subscription);
      setQr(json.qr ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  async function act(action: "cancel" | "reactivate") {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/subscribe/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.reason || "ทำรายการไม่สำเร็จ");
      setSub(json.subscription);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  const card: React.CSSProperties = { padding: 22, borderRadius: T.radius, background: T.surface, border: `1px solid ${T.border}` };

  return (
    <main style={{ minHeight: "100dvh", padding: "clamp(20px,4vw,44px) 20px 80px" }}>
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <a href="/" style={{ color: T.muted, fontSize: "0.9rem", fontWeight: 600 }}>← กลับหน้าหลัก</a>
        <h1 style={{ fontSize: "clamp(1.5rem,3vw,2rem)", marginTop: 14, marginBottom: 20 }}>จัดการสมาชิก</h1>

        {loading && <p style={{ color: T.muted }}>กำลังโหลด...</p>}

        {!loading && error && !sub && (
          <div style={{ ...card, color: T.danger }}>
            {error}
            <div style={{ marginTop: 12 }}>
              <a href="/#pricing" style={{ color: T.primary, fontWeight: 700 }}>ดูแพ็กเกจ / สมัครใหม่ →</a>
            </div>
          </div>
        )}

        {sub && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: "0.82rem", color: T.muted }}>{sub.business_name}</div>
                  <div style={{ fontSize: "1.6rem", fontWeight: 800, color: T.fgStrong, marginTop: 2 }}>
                    UP Line {sub.plan_key.charAt(0).toUpperCase() + sub.plan_key.slice(1)}
                  </div>
                  <div style={{ color: T.muted, fontSize: "0.9rem", marginTop: 2 }}>
                    {baht(sub.amount)} · {sub.billing_cycle === "yearly" ? "รายปี" : "รายเดือน"}
                  </div>
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: "0.85rem", color: STATUS_META[sub.status].color, background: STATUS_META[sub.status].weak, padding: "6px 12px", borderRadius: 999 }}>
                  ● {STATUS_META[sub.status].label}
                </span>
              </div>

              <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "18px 0" }} />

              <Row k="เลขอ้างอิง" v={sub.payment_ref} />
              <Row k="ผู้ติดต่อ" v={`${sub.customer_name} · ${sub.customer_email}`} />
              <Row k={sub.cancel_at_period_end ? "ใช้งานได้ถึง" : "รอบถัดไป"} v={fmtDate(sub.current_period_end)} />

              {sub.cancel_at_period_end && sub.status !== "canceled" && (
                <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 10, background: T.dangerWeak, color: T.danger, fontSize: "0.85rem" }}>
                  ตั้งค่ายกเลิกแล้ว — จะไม่ต่ออายุอัตโนมัติ ใช้งานได้จนถึงวันสิ้นสุดรอบ
                </div>
              )}

              {error && <div style={{ marginTop: 12, color: T.danger, fontSize: "0.85rem" }}>{error}</div>}

              <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
                {sub.cancel_at_period_end || sub.status === "canceled" ? (
                  <button onClick={() => act("reactivate")} disabled={busy} style={{ padding: "11px 18px", borderRadius: 11, border: "none", background: T.primary, color: T.primaryFg, fontWeight: 700, opacity: busy ? 0.6 : 1 }}>
                    {busy ? "กำลังทำรายการ..." : "กลับมาใช้งานต่อ"}
                  </button>
                ) : (
                  <button onClick={() => act("cancel")} disabled={busy} style={{ padding: "11px 18px", borderRadius: 11, border: `1px solid ${T.border}`, background: T.surface, color: T.danger, fontWeight: 700, opacity: busy ? 0.6 : 1 }}>
                    {busy ? "กำลังทำรายการ..." : "ยกเลิกการต่ออายุ"}
                  </button>
                )}
                <a href="/#pricing" style={{ padding: "11px 18px", borderRadius: 11, border: `1px solid ${T.border}`, background: T.surface, color: T.fg, fontWeight: 700 }}>
                  เปลี่ยนแพ็กเกจ
                </a>
              </div>
            </div>

            {sub.status === "pending" && qr && (
              <div style={card}>
                <div style={{ fontWeight: 800, color: T.fgStrong, marginBottom: 4 }}>ชำระเงินเพื่อเปิดใช้งาน</div>
                <p style={{ color: T.muted, fontSize: "0.88rem", marginBottom: 14 }}>สแกน PromptPay ยอด {baht(sub.amount)} — จ่ายแล้วทีมงานยืนยันภายใน 1 ชม.ทำการ</p>
                <div style={{ background: "#fff", padding: 12, borderRadius: 14, width: 200, height: 200, display: "grid", placeItems: "center" }} dangerouslySetInnerHTML={{ __html: qr.svg }} />
                {/* Auto-verify: decode the slip's QR ourselves and activate (no paid API). */}
                <SlipUpload manageToken={sub.manage_token} onActivated={() => token && load(token)} />
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", fontSize: "0.92rem" }}>
      <span style={{ color: T.muted }}>{k}</span>
      <span style={{ color: T.fg, fontWeight: 600, textAlign: "right" }}>{v}</span>
    </div>
  );
}
