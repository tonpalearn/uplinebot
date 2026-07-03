"use client";

// Manage Customers — list every onboarded tenant, their connected LINE OA(s), and
// toggle which modules each customer is entitled to. Complements the onboarding wizard:
// onboarding CREATES a customer; this page VIEWS and MANAGES them.
//
// Reads: GET /api/admin/tenants, GET /api/admin/bots?tenant_id=, GET /api/admin/module-catalog
// Writes: POST /api/admin/subscriptions { tenant_id, module_key, enabled }  (toggle on/off)
// All admin calls carry the x-admin-token header (shared localStorage key with onboarding).

import { useCallback, useEffect, useState } from "react";
import { Banner, Button, COLORS, FONT, Panel, TextInput } from "../onboarding/ui";

const ADMIN_TOKEN_STORAGE_KEY = "upl_admin_token";
const HIGHLIGHT_KEY = "slip_verification";

type PlanTier = "starter" | "pro" | "business";

interface ModuleItem {
  module_key: string;
  name: string;
  requires_api_key: boolean;
  tier_min: PlanTier;
  addon_price_thb: number | null;
  is_core: boolean;
}
interface Tenant {
  id: string;
  name: string;
  plan_tier: PlanTier;
  created_at: string;
  module_keys: string[];
}
interface Bot {
  id: string;
  line_channel_id: string;
  group_reply_mode: string;
  active: boolean;
  created_at: string;
}

const TIER_COLOR: Record<PlanTier, string> = {
  starter: COLORS.blue,
  pro: COLORS.green,
  business: COLORS.gold,
};

class AdminApiError extends Error {
  unauthorized: boolean;
  constructor(message: string, unauthorized = false) {
    super(message);
    this.unauthorized = unauthorized;
  }
}

export default function CustomersPage() {
  const [adminToken, setAdminToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  useEffect(() => {
    const saved = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (saved) setAdminToken(saved);
    setWebhookUrl(`${window.location.origin}/api/line/webhook`);
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

  const [modules, setModules] = useState<ModuleItem[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [botsByTenant, setBotsByTenant] = useState<Record<string, Bot[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set()); // `${tenantId}:${moduleKey}` in-flight

  const load = useCallback(async () => {
    if (!adminToken) {
      setNeedToken(true);
      return;
    }
    setLoading(true);
    setError(null);
    setNeedToken(false);
    try {
      const [cat, ten] = await Promise.all([
        adminFetch("/api/admin/module-catalog"),
        adminFetch("/api/admin/tenants"),
      ]);
      const tenantList: Tenant[] = ten.tenants || [];
      setModules(cat.modules || []);
      setTenants(tenantList);

      const botEntries = await Promise.all(
        tenantList.map(async (t) => {
          try {
            const b = await adminFetch(`/api/admin/bots?tenant_id=${encodeURIComponent(t.id)}`);
            return [t.id, b.bots || []] as const;
          } catch {
            return [t.id, []] as const;
          }
        })
      );
      setBotsByTenant(Object.fromEntries(botEntries));
      setLoadedOnce(true);
    } catch (e) {
      const err = e as AdminApiError;
      if (err.unauthorized) setNeedToken(true);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [adminToken, adminFetch]);

  useEffect(() => {
    if (adminToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken]);

  async function toggleModule(tenant: Tenant, moduleKey: string, nextEnabled: boolean) {
    const busyKey = `${tenant.id}:${moduleKey}`;
    setBusy((prev) => new Set(prev).add(busyKey));
    setError(null);
    try {
      await adminFetch("/api/admin/subscriptions", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenant.id, module_key: moduleKey, enabled: nextEnabled }),
      });
      setTenants((prev) =>
        prev.map((t) => {
          if (t.id !== tenant.id) return t;
          const set = new Set(t.module_keys);
          if (nextEnabled) set.add(moduleKey);
          else set.delete(moduleKey);
          return { ...t, module_keys: [...set] };
        })
      );
    } catch (e) {
      const err = e as AdminApiError;
      if (err.unauthorized) setNeedToken(true);
      setError(`ปรับสิทธิ์โมดูลไม่สำเร็จ: ${err.message}`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }

  const coreModules = modules.filter((m) => m.is_core);
  const sellableModules = modules.filter((m) => !m.is_core);

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
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>จัดการลูกค้า</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: COLORS.textMuted }}>
              รายชื่อลูกค้าที่ onboard แล้ว · เชื่อม LINE OA · เปิด/ปิดสิทธิ์โมดูล
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Button variant="ghost" onClick={() => load()} disabled={loading}>
              {loading ? "กำลังโหลด…" : "รีเฟรช"}
            </Button>
            <a href="/onboarding" style={{ textDecoration: "none" }}>
              <Button variant="primary">+ เพิ่มลูกค้าใหม่</Button>
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

        {/* Webhook reminder */}
        {webhookUrl && (
          <Banner kind="info">
            Webhook URL (วางในทุก LINE OA ลูกค้า): <code style={{ wordBreak: "break-all" }}>{webhookUrl}</code>
          </Banner>
        )}

        {/* Empty state */}
        {loadedOnce && tenants.length === 0 && !loading && (
          <Panel>
            <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 14 }}>
              ยังไม่มีลูกค้า — กด <strong style={{ color: COLORS.textMain }}>+ เพิ่มลูกค้าใหม่</strong> เพื่อ onboard รายแรก
            </p>
          </Panel>
        )}

        {/* Tenant cards */}
        {tenants.map((t) => {
          const bots = botsByTenant[t.id] || [];
          const enabledSet = new Set(t.module_keys);
          return (
            <Panel key={t.id}>
              {/* Tenant header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t.name}</h2>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color: "var(--primary-fg)",
                      background: TIER_COLOR[t.plan_tier],
                      borderRadius: 999,
                      padding: "2px 9px",
                    }}
                  >
                    {t.plan_tier}
                  </span>
                </div>
                <span style={{ fontSize: 12, color: COLORS.textMuted }}>
                  สร้าง {new Date(t.created_at).toLocaleDateString("th-TH")}
                </span>
              </div>

              {/* Connected LINE OA */}
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, marginBottom: 6 }}>LINE OA ที่เชื่อม</div>
                {bots.length === 0 ? (
                  <div style={{ fontSize: 13, color: COLORS.danger }}>
                    ⚠ ยังไม่ได้เชื่อม LINE OA — เปิด “เพิ่มลูกค้าใหม่” เพื่อกรอก Bot User ID / secret / token
                  </div>
                ) : (
                  bots.map((b) => (
                    <div
                      key={b.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                        fontSize: 13,
                        padding: "6px 0",
                      }}
                    >
                      <code style={{ color: COLORS.blue, wordBreak: "break-all" }}>{b.line_channel_id}</code>
                      <span style={{ color: COLORS.textMuted }}>· {b.group_reply_mode}</span>
                      <span style={{ color: b.active ? COLORS.green : COLORS.danger }}>
                        {b.active ? "● active" : "○ inactive"}
                      </span>
                    </div>
                  ))
                )}
              </div>

              {/* Module entitlements */}
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, marginBottom: 8 }}>
                  สิทธิ์โมดูล (กดเพื่อเปิด/ปิด)
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
                  {sellableModules.map((m) => {
                    const on = enabledSet.has(m.module_key);
                    const busyKey = `${t.id}:${m.module_key}`;
                    const isBusy = busy.has(busyKey);
                    const gold = m.module_key === HIGHLIGHT_KEY;
                    return (
                      <button
                        key={m.module_key}
                        onClick={() => toggleModule(t, m.module_key, !on)}
                        disabled={isBusy}
                        style={{
                          textAlign: "left",
                          cursor: isBusy ? "wait" : "pointer",
                          borderRadius: 10,
                          padding: "9px 11px",
                          fontFamily: FONT,
                          background: on ? "var(--success-weak)" : "var(--surface-2)",
                          border: `1px solid ${on ? COLORS.green : COLORS.border}`,
                          opacity: isBusy ? 0.6 : 1,
                          color: COLORS.textMain,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {gold ? "🔥 " : ""}
                            {m.name}
                          </span>
                          <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                            {m.addon_price_thb ? `${m.addon_price_thb.toLocaleString()}฿/เดือน` : "รวมใน tier"}
                          </span>
                        </span>
                        <span
                          style={{
                            flex: "0 0 auto",
                            fontSize: 11,
                            fontWeight: 700,
                            color: on ? "var(--primary-fg)" : COLORS.textMuted,
                            background: on ? COLORS.green : "transparent",
                            border: on ? "none" : `1px solid ${COLORS.border}`,
                            borderRadius: 999,
                            padding: "2px 8px",
                          }}
                        >
                          {isBusy ? "…" : on ? "ON" : "OFF"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {coreModules.length > 0 && (
                  <p style={{ margin: "10px 0 0", fontSize: 11, color: COLORS.textMuted }}>
                    รวมในระบบเสมอ: {coreModules.map((m) => m.name).join(" · ")}
                  </p>
                )}
              </div>
            </Panel>
          );
        })}
      </div>
    </main>
  );
}
