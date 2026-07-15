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

  // Replace a bot in local state after an in-place edit (PATCH), keeping its tenant grouping.
  function updateBot(tenantId: string, updated: Bot) {
    setBotsByTenant((prev) => ({
      ...prev,
      [tenantId]: (prev[tenantId] || []).map((b) => (b.id === updated.id ? { ...b, ...updated } : b)),
    }));
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
              {/* Tenant header — rename / change tier / delete customer */}
              <TenantHeader
                tenant={t}
                adminFetch={adminFetch}
                onSaved={(u) => setTenants((prev) => prev.map((x) => (x.id === u.id ? { ...x, ...u } : x)))}
                onDeleted={(id) => {
                  setTenants((prev) => prev.filter((x) => x.id !== id));
                  setBotsByTenant((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                  });
                }}
              />

              {/* Connected LINE OA */}
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, marginBottom: 6 }}>LINE OA ที่เชื่อม</div>
                {bots.length === 0 ? (
                  <div style={{ fontSize: 13, color: COLORS.danger }}>
                    ⚠ ยังไม่ได้เชื่อม LINE OA — เปิด “เพิ่มลูกค้าใหม่” เพื่อกรอก Bot User ID / secret / token
                  </div>
                ) : (
                  bots.map((b) => (
                    <BotRow
                      key={b.id}
                      bot={b}
                      adminFetch={adminFetch}
                      onSaved={(updated) => updateBot(t.id, updated)}
                    />
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

// Tenant header — view name + tier, or edit (rename / change plan tier) and delete the customer.
// Delete is DESTRUCTIVE (cascades to the tenant's bots, todos, ledger, KM, entitlements, logs);
// guarded by a two-step inline confirm (no browser confirm() which some webviews block).
function TenantHeader({
  tenant,
  adminFetch,
  onSaved,
  onDeleted,
}: {
  tenant: Tenant;
  adminFetch: AdminFetch;
  onSaved: (t: Tenant) => void;
  onDeleted: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tenant.name);
  const [tier, setTier] = useState<PlanTier>(tenant.plan_tier);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setErr("ชื่อห้ามว่าง");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const j = await adminFetch("/api/admin/tenants", {
        method: "PATCH",
        body: JSON.stringify({ id: tenant.id, name: name.trim(), plan_tier: tier }),
      });
      onSaved({ ...tenant, ...(j.tenant as Tenant) });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await adminFetch("/api/admin/tenants", { method: "DELETE", body: JSON.stringify({ id: tenant.id }) });
      onDeleted(tenant.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "ลบไม่สำเร็จ");
      setBusy(false);
      setConfirming(false);
    }
  };

  if (editing) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, background: "var(--surface-2)", border: `1px solid ${COLORS.blue}` }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600 }}>ชื่อลูกค้า / ธุรกิจ</label>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อลูกค้า" />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600 }}>แพ็กเกจ</label>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {(["starter", "pro", "business"] as PlanTier[]).map((p) => {
              const on = tier === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setTier(p)}
                  style={{
                    padding: "7px 14px",
                    borderRadius: 8,
                    border: `1px solid ${on ? TIER_COLOR[p] : COLORS.border}`,
                    background: on ? "var(--primary-weak)" : "transparent",
                    color: on ? TIER_COLOR[p] : COLORS.textMuted,
                    fontWeight: 700,
                    fontSize: 12,
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        {err && <div style={{ color: COLORS.danger, fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setName(tenant.name);
              setTier(tenant.plan_tier);
              setErr(null);
            }}
          >
            ยกเลิก
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{tenant.name}</h2>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            color: "var(--primary-fg)",
            background: TIER_COLOR[tenant.plan_tier],
            borderRadius: 999,
            padding: "2px 9px",
          }}
        >
          {tenant.plan_tier}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: COLORS.textMuted }}>สร้าง {new Date(tenant.created_at).toLocaleDateString("th-TH")}</span>
        <Button variant="ghost" onClick={() => setEditing(true)}>
          ✏️ แก้ไข
        </Button>
        {confirming ? (
          <>
            <span style={{ fontSize: 12, color: COLORS.danger, fontWeight: 600 }}>ลบลูกค้า+บอท+ข้อมูลทั้งหมด?</span>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: COLORS.danger, color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
            >
              {busy ? "กำลังลบ…" : "ยืนยันลบ"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: "transparent", color: COLORS.textMuted, fontSize: 12, cursor: "pointer" }}
            >
              ยกเลิก
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${COLORS.danger}`, background: "transparent", color: COLORS.danger, fontWeight: 600, fontSize: 12, cursor: "pointer" }}
          >
            🗑 ลบ
          </button>
        )}
      </div>
      {err && <div style={{ color: COLORS.danger, fontSize: 13, width: "100%" }}>{err}</div>}
    </div>
  );
}

// Result of POST /api/admin/bots/verify — the real bot info from LINE (or a failure reason).
type VerifyResp = {
  verified?: boolean;
  matches?: boolean;
  mock?: boolean;
  reason?: string;
  storedChannelId?: string;
  info?: { userId?: string | null; basicId?: string | null; displayName?: string | null };
};

// Renders the LINE verification result: connected+match (green), token-ok-but-mismatch (amber
// with the REAL Bot User ID to copy), or a failure (red with a human reason).
function VerifyResult({ r }: { r: VerifyResp }) {
  const ok = Boolean(r.verified && r.matches);
  const mismatch = Boolean(r.verified && !r.matches);
  const reasonText: Record<string, string> = {
    invalid_access_token: "Access Token ผิดหรือหมดอายุ — กด ✏️ แก้ไข ใส่ token ใหม่",
    line_unreachable: "ต่อ LINE ไม่ได้ ลองใหม่อีกครั้ง",
    decrypt_failed: "ถอดรหัส token ไม่ได้ (ENCRYPTION_KEY ไม่ตรงกับตอนบันทึก)",
  };
  const bd = ok ? COLORS.green : mismatch ? COLORS.gold : COLORS.danger;
  const bg = ok ? "var(--success-weak)" : mismatch ? "rgba(234,179,8,.12)" : "var(--danger-weak)";
  return (
    <div style={{ marginTop: 8, padding: "8px 11px", borderRadius: 8, background: bg, border: `1px solid ${bd}`, fontSize: 12.5, lineHeight: 1.5 }}>
      {ok && (
        <span style={{ color: COLORS.green }}>
          ✅ เชื่อมถูกต้อง · <b>{r.info?.displayName || "บอท"}</b>
          {r.info?.basicId ? ` (${r.info.basicId})` : ""} · Bot User ID ตรงกับของจริง{r.mock ? " · (mock)" : ""}
        </span>
      )}
      {mismatch && (
        <span style={{ color: COLORS.gold }}>
          ⚠ Token ใช้ได้ แต่ Bot User ID ที่เก็บ<b>ไม่ตรง</b> — ของจริงคือ{" "}
          <code style={{ wordBreak: "break-all", color: COLORS.textMain }}>{r.info?.userId}</code> · กด ✏️ แก้ไข ให้ตรง
        </span>
      )}
      {!r.verified && <span style={{ color: COLORS.danger }}>❌ {reasonText[r.reason || ""] || r.reason || "ตรวจไม่สำเร็จ"}</span>}
    </div>
  );
}

// One connected LINE OA row: shows the Bot User ID (copyable) + reply mode + status, and an
// in-place edit form (fix the Bot User ID, switch reply mode, or re-enter secret/token).
type AdminFetch = (path: string, init?: RequestInit) => Promise<any>;
type DetectedDest = { destination: string; count: number; matched: boolean };
const REPLY_MODES: { key: "mention_only" | "prefix" | "all"; label: string }[] = [
  { key: "all", label: "ทุกข้อความ" },
  { key: "mention_only", label: "เมื่อ @บอท" },
  { key: "prefix", label: "มีคำนำหน้า" },
];

function BotRow({ bot, adminFetch, onSaved }: { bot: Bot; adminFetch: AdminFetch; onSaved: (updated: Bot) => void }) {
  const [editing, setEditing] = useState(false);
  const [channelId, setChannelId] = useState(bot.line_channel_id);
  const [replyMode, setReplyMode] = useState<string>(bot.group_reply_mode);
  const [prefix, setPrefix] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectedDest[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResp | null>(null);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(bot.line_channel_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const detect = async () => {
    setDetecting(true);
    setErr(null);
    try {
      const j = await adminFetch("/api/admin/recent-destinations");
      setDetected((j.destinations ?? []) as DetectedDest[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "ดึงข้อมูลไม่สำเร็จ");
    } finally {
      setDetecting(false);
    }
  };

  // Actually verify against LINE: calls /v2/bot/info with the stored token → real Bot User ID + name.
  const verify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const j = await adminFetch("/api/admin/bots/verify", { method: "POST", body: JSON.stringify({ id: bot.id }) });
      setVerifyResult(j as VerifyResp);
    } catch (e) {
      setVerifyResult({ verified: false, reason: e instanceof Error ? e.message : "ตรวจไม่สำเร็จ" });
    } finally {
      setVerifying(false);
    }
  };

  const save = async () => {
    if (!channelId.trim()) {
      setErr("Bot User ID ห้ามว่าง");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const j = await adminFetch("/api/admin/bots", {
        method: "PATCH",
        body: JSON.stringify({
          id: bot.id,
          line_channel_id: channelId.trim(),
          group_reply_mode: replyMode,
          default_prefix: replyMode === "prefix" ? prefix.trim() : undefined,
          channel_secret: secret.trim() || undefined,
          access_token: token.trim() || undefined,
        }),
      });
      onSaved(j.bot as Bot);
      setSecret("");
      setToken("");
      setDetected(null);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div style={{ padding: "8px 0", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: COLORS.textMuted }}>Bot User ID</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{ color: COLORS.blue, wordBreak: "break-all", fontSize: 13 }}>{bot.line_channel_id}</code>
              <button
                type="button"
                onClick={copyId}
                style={{ border: "none", background: "transparent", color: COLORS.textMuted, cursor: "pointer", fontSize: 12 }}
              >
                {copied ? "✓ คัดลอกแล้ว" : "📋 คัดลอก"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
              โหมด: {REPLY_MODES.find((m) => m.key === bot.group_reply_mode)?.label ?? bot.group_reply_mode} ·{" "}
              <span style={{ color: bot.active ? COLORS.green : COLORS.danger }}>{bot.active ? "● active" : "○ inactive"}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button variant="ghost" onClick={verify} disabled={verifying}>
              {verifying ? "กำลังตรวจ…" : "🔍 ตรวจกับ LINE"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(true)}>
              ✏️ แก้ไข
            </Button>
          </div>
        </div>
        {verifyResult && <VerifyResult r={verifyResult} />}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        borderRadius: 12,
        background: "var(--surface-2)",
        border: `1px solid ${COLORS.blue}`,
        marginBottom: 8,
      }}
    >
      <div>
        <label style={{ fontSize: 12, fontWeight: 600 }}>Bot User ID (destination)</label>
        <TextInput value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="U0a1b2c3..." />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={detect}
            disabled={detecting}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: `1px solid ${COLORS.blue}`,
              background: "transparent",
              color: COLORS.blue,
              fontWeight: 600,
              fontSize: 12,
              cursor: detecting ? "default" : "pointer",
              opacity: detecting ? 0.6 : 1,
            }}
          >
            {detecting ? "กำลังตรวจ..." : "🔍 ตรวจจาก webhook ล่าสุด"}
          </button>
          <span style={{ fontSize: 11, color: COLORS.textMuted }}>ทักบอท 1 ข้อความ แล้วกดตรวจ → เลือกตัวที่ถูก</span>
        </div>
        {detected && detected.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {detected.map((d) => (
              <button
                key={d.destination}
                type="button"
                onClick={() => setChannelId(d.destination)}
                style={{
                  textAlign: "left",
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: `1px solid ${d.matched ? COLORS.border : COLORS.green}`,
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                <code style={{ color: COLORS.textMain, fontSize: 12, wordBreak: "break-all" }}>{d.destination}</code>
                <span style={{ fontSize: 11, color: d.matched ? COLORS.textMuted : COLORS.green, marginLeft: 8 }}>
                  {d.matched ? "ผูกแล้ว" : "✅ ยังไม่ผูก"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600 }}>โหมดตอบในกลุ่ม</label>
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {REPLY_MODES.map((m) => {
            const on = replyMode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setReplyMode(m.key)}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: `1px solid ${on ? COLORS.blue : COLORS.border}`,
                  background: on ? "var(--primary-weak)" : "transparent",
                  color: on ? COLORS.blue : COLORS.textMuted,
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        {replyMode === "prefix" && (
          <div style={{ marginTop: 8 }}>
            <TextInput value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="คำนำหน้า เช่น /บอท" />
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Channel Secret</label>
          <TextInput type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="เว้นว่าง = ไม่เปลี่ยน" autoComplete="off" />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Access Token</label>
          <TextInput type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="เว้นว่าง = ไม่เปลี่ยน" autoComplete="off" />
        </div>
      </div>

      {err && <div style={{ color: COLORS.danger, fontSize: 13 }}>{err}</div>}

      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? "กำลังบันทึก…" : "บันทึก"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setChannelId(bot.line_channel_id);
            setReplyMode(bot.group_reply_mode);
            setSecret("");
            setToken("");
            setErr(null);
            setDetected(null);
          }}
        >
          ยกเลิก
        </Button>
      </div>
    </div>
  );
}
