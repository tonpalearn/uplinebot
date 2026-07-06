"use client";

// Manage Subscriptions — the seller's console for self-serve signups: review every
// subscription (business, plan, cycle, amount, ref, status), see the payment slip(s) the
// customer uploaded (decoded transRef / bank / hash), and confirm or reject payment.
//
// This is the permanent home for "customer paid — now what", AND the fallback when the
// customer's automatic slip verification (POST /api/subscribe/verify-slip) couldn't read the QR.
//
// Reads:  GET  /api/admin/customer-subscriptions?status=   → subscriptions
//         GET  /api/admin/customer-subscriptions/slips?id=  → slips for one subscription
// Writes: POST /api/admin/customer-subscriptions { ref, status } → 'active' (confirm) / 'canceled' (reject)
// All admin calls carry the x-admin-token header (shared localStorage key with onboarding/customers).

import { useCallback, useEffect, useState } from "react";
import { Banner, Button, COLORS, FONT, Panel, TextInput } from "../onboarding/ui";

const ADMIN_TOKEN_STORAGE_KEY = "upl_admin_token";

type SubStatus = "pending" | "active" | "canceled" | "past_due";

interface Sub {
  id: string;
  plan_key: string;
  billing_cycle: string;
  status: SubStatus;
  business_name: string;
  customer_name: string;
  customer_email: string;
  amount: number;
  payment_ref: string;
  created_at: string;
}
interface Slip {
  id: string;
  raw_qr: string | null;
  trans_ref: string | null;
  sending_bank: string | null;
  amount: number | null;
  image_hash: string;
  created_at: string;
}

const STATUS_META: Record<SubStatus, { label: string; color: string }> = {
  pending: { label: "รอยืนยัน", color: COLORS.gold },
  active: { label: "ใช้งานอยู่", color: COLORS.green },
  canceled: { label: "ยกเลิก", color: COLORS.danger },
  past_due: { label: "ค้างชำระ", color: COLORS.danger },
};

const FILTERS: { key: "" | SubStatus; label: string }[] = [
  { key: "pending", label: "รอยืนยัน" },
  { key: "active", label: "ใช้งานอยู่" },
  { key: "canceled", label: "ยกเลิก" },
  { key: "", label: "ทั้งหมด" },
];

const baht = (n: number) => "฿" + n.toLocaleString("th-TH");
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

class AdminApiError extends Error {
  unauthorized: boolean;
  constructor(message: string, unauthorized = false) {
    super(message);
    this.unauthorized = unauthorized;
  }
}

export default function SubscriptionsPage() {
  const [adminToken, setAdminToken] = useState("");
  const [filter, setFilter] = useState<"" | SubStatus>("pending");

  useEffect(() => {
    const saved = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (saved) setAdminToken(saved);
  }, []);
  useEffect(() => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
  }, [adminToken]);

  const adminFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", "x-admin-token": adminToken, ...(init?.headers || {}) },
      });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        throw new AdminApiError(`เซิร์ฟเวอร์ตอบไม่ถูกต้อง (HTTP ${res.status})`, res.status === 401);
      }
      if (!res.ok || !json?.ok) {
        throw new AdminApiError(json?.reason || `HTTP ${res.status}`, res.status === 401);
      }
      return json;
    },
    [adminToken]
  );

  const [subs, setSubs] = useState<Sub[]>([]);
  const [slipsBySub, setSlipsBySub] = useState<Record<string, Slip[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!adminToken) {
      setNeedToken(true);
      return;
    }
    setLoading(true);
    setError(null);
    setNeedToken(false);
    try {
      const qs = filter ? `?status=${filter}` : "";
      const j = await adminFetch(`/api/admin/customer-subscriptions${qs}`);
      const list: Sub[] = j.subscriptions || [];
      setSubs(list);
      setLoadedOnce(true);

      // Fetch slips for each subscription so the reviewer can see what was uploaded.
      const entries = await Promise.all(
        list.map(async (s) => {
          try {
            const sj = await adminFetch(`/api/admin/customer-subscriptions/slips?id=${encodeURIComponent(s.id)}`);
            return [s.id, sj.slips || []] as const;
          } catch {
            return [s.id, []] as const;
          }
        })
      );
      setSlipsBySub(Object.fromEntries(entries));
    } catch (e) {
      const err = e as AdminApiError;
      if (err.unauthorized) setNeedToken(true);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [adminToken, adminFetch, filter]);

  useEffect(() => {
    if (adminToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, filter]);

  async function setStatus(sub: Sub, status: "active" | "canceled") {
    setBusyRef(sub.payment_ref);
    setError(null);
    try {
      const j = await adminFetch("/api/admin/customer-subscriptions", {
        method: "POST",
        body: JSON.stringify({ ref: sub.payment_ref, status }),
      });
      const updated = j.subscription as Sub;
      setSubs((prev) =>
        // If a filter is active and the row no longer matches, drop it; else update in place.
        prev
          .map((s) => (s.id === sub.id ? { ...s, ...updated } : s))
          .filter((s) => (filter ? s.status === filter : true))
      );
    } catch (e) {
      const err = e as AdminApiError;
      if (err.unauthorized) setNeedToken(true);
      setError(`อัปเดตสถานะไม่สำเร็จ: ${err.message}`);
    } finally {
      setBusyRef(null);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: COLORS.pageBg,
        color: COLORS.textMain,
        fontFamily: FONT,
        padding: "28px 20px 80px",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>จัดการการสมัคร</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: COLORS.textMuted }}>
              ตรวจสลิป · ยืนยันการชำระเงิน · เปิด/ปิดการสมัครของลูกค้า
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Button variant="ghost" onClick={() => load()} disabled={loading}>
              {loading ? "กำลังโหลด…" : "รีเฟรช"}
            </Button>
            <a href="/customers" style={{ textDecoration: "none" }}>
              <Button variant="ghost">จัดการลูกค้า →</Button>
            </a>
          </div>
        </div>

        {/* Admin token */}
        <Panel>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Admin Token <span style={{ color: COLORS.danger }}>*จำเป็น</span>
          </label>
          <TextInput
            type="password"
            value={adminToken}
            placeholder="วาง ADMIN_TOKEN ที่ตั้งไว้ใน Vercel env"
            onChange={(e) => setAdminToken(e.target.value)}
          />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: COLORS.textMuted }}>
            ส่งเป็น header <code>x-admin-token</code> ทุกคำขอ · เก็บในเบราว์เซอร์นี้เท่านั้น
          </p>
        </Panel>

        {needToken && <Banner kind="error">ต้องใส่ Admin Token ที่ถูกต้องก่อน (โทเคนไม่ถูกหรือยังไม่ได้ใส่)</Banner>}
        {error && !needToken && <Banner kind="error">{error}</Banner>}

        {/* Status filter */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <button
                key={f.key || "all"}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  padding: "7px 14px",
                  borderRadius: 999,
                  border: `1px solid ${on ? COLORS.blue : COLORS.border}`,
                  background: on ? "var(--primary-weak)" : "transparent",
                  color: on ? COLORS.blue : COLORS.textMuted,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Empty state */}
        {loadedOnce && subs.length === 0 && !loading && (
          <Panel>
            <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 14 }}>
              ยังไม่มีรายการสมัคร{filter ? "ในสถานะนี้" : ""}
            </p>
          </Panel>
        )}

        {/* Subscription cards */}
        {subs.map((s) => {
          const slips = slipsBySub[s.id] || [];
          const meta = STATUS_META[s.status];
          const isBusy = busyRef === s.payment_ref;
          return (
            <Panel key={s.id}>
              {/* Row header */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{s.business_name}</h2>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--primary-fg)",
                        background: meta.color,
                        borderRadius: 999,
                        padding: "2px 9px",
                      }}
                    >
                      {meta.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4 }}>
                    {s.customer_name} · {s.customer_email}
                  </div>
                  <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 2 }}>
                    <span style={{ textTransform: "uppercase", fontWeight: 700, color: COLORS.textMain }}>{s.plan_key}</span>
                    {" · "}
                    {s.billing_cycle === "yearly" ? "รายปี" : "รายเดือน"}
                    {" · "}
                    <span style={{ color: COLORS.textMain, fontWeight: 700 }}>{baht(s.amount)}</span>
                    {" · "}
                    <code style={{ color: COLORS.blue }}>{s.payment_ref}</code>
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                    สมัคร {fmtDateTime(s.created_at)}
                  </div>
                </div>

                {/* Confirm / reject (pending only) */}
                {s.status === "pending" && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button variant="primary" onClick={() => setStatus(s, "active")} disabled={isBusy}>
                      {isBusy ? "…" : "✅ ยืนยันจ่าย"}
                    </Button>
                    <Button variant="ghost" onClick={() => setStatus(s, "canceled")} disabled={isBusy}>
                      ❌ ปฏิเสธ
                    </Button>
                  </div>
                )}
              </div>

              {/* Uploaded slips */}
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, marginBottom: 6 }}>
                  สลิปที่อัปโหลด ({slips.length})
                </div>
                {slips.length === 0 ? (
                  <div style={{ fontSize: 13, color: COLORS.textMuted }}>— ยังไม่มีสลิป (ลูกค้าอาจจ่ายแล้วแต่ยังไม่อัปโหลด)</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {slips.map((sl) => (
                      <div
                        key={sl.id}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          background: "var(--surface-2)",
                          border: `1px solid ${COLORS.border}`,
                          fontSize: 12,
                          lineHeight: 1.6,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                          <span style={{ color: COLORS.textMuted }}>
                            transRef:{" "}
                            <code style={{ color: sl.trans_ref ? COLORS.green : COLORS.textMuted }}>
                              {sl.trans_ref || "— (อ่านไม่ได้)"}
                            </code>
                          </span>
                          <span style={{ color: COLORS.textMuted }}>{fmtDateTime(sl.created_at)}</span>
                        </div>
                        <div style={{ color: COLORS.textMuted }}>
                          ธนาคาร: <code style={{ color: COLORS.textMain }}>{sl.sending_bank || "—"}</code>
                          {sl.amount != null && (
                            <>
                              {" · "}ยอดในสลิป: <code style={{ color: COLORS.textMain }}>{baht(sl.amount)}</code>
                            </>
                          )}
                        </div>
                        <div style={{ color: COLORS.textMuted, wordBreak: "break-all" }}>
                          hash: <code style={{ color: COLORS.textMuted, fontSize: 11 }}>{sl.image_hash.slice(0, 24)}…</code>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          );
        })}
      </div>
    </main>
  );
}
