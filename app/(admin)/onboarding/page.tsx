"use client";

// Admin ONBOARDING wizard — add a new customer in one screen (SPEC.md §6.2 "Guided Onboarding").
//
// Three stepped panels:
//   1. Create customer (tenant) + grant modules  -> POST /api/admin/tenants
//   2. Connect the customer's LINE OA            -> POST /api/admin/bots
//   3. Done: copy the single shared webhook URL into the customer's LINE console.
//
// Multi-tenant single-webhook model (unchanged): there is ONE webhook URL for every
// customer. Inbound events route by the payload `destination` (the OA Bot User ID) ->
// upl_bots.line_channel_id; the signature is verified per-bot. Step 2 collects exactly
// that Bot User ID, and step 3 shows the one URL to paste.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banner,
  Button,
  COLORS,
  FONT,
  Help,
  Label,
  Panel,
  Select,
  StepHeader,
  TextInput,
} from "./ui";

const ADMIN_TOKEN_STORAGE_KEY = "upl_admin_token";

interface ModuleCatalogItem {
  module_key: string;
  name: string;
  requires_api_key: boolean;
  tier_min: PlanTier;
  addon_price_thb: number | null;
  is_core: boolean;
}

type PlanTier = "starter" | "pro" | "business";
const PLAN_TIERS: PlanTier[] = ["starter", "pro", "business"];
const TIER_RANK: Record<PlanTier, number> = { starter: 0, pro: 1, business: 2 };
const HIGHLIGHT_KEY = "slip_verification"; // gold "แนะนำ" module (SPEC §6.5)

type GroupReplyMode = "mention_only" | "prefix" | "all";

interface CreatedTenant {
  id: string;
  name: string;
  plan_tier: PlanTier;
}

// A thrown error that carries the fact it was a 401, so the UI can show the token message.
class AdminApiError extends Error {
  unauthorized: boolean;
  constructor(message: string, unauthorized = false) {
    super(message);
    this.unauthorized = unauthorized;
  }
}

export default function OnboardingPage() {
  // ---- Admin token (state + localStorage) ---------------------------------
  const [adminToken, setAdminToken] = useState("");
  useEffect(() => {
    const saved = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (saved) setAdminToken(saved);
  }, []);
  useEffect(() => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
  }, [adminToken]);

  // Every admin call goes through this so the x-admin-token header is always attached
  // and a 401 becomes a typed error.
  const adminFetch = useCallback(
    async (url: string, init?: RequestInit) => {
      const res = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": adminToken,
          ...(init?.headers || {}),
        },
      });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        // fall through to status-based error below
      }
      if (res.status === 401) {
        throw new AdminApiError("Admin Token ไม่ถูกต้องหรือยังไม่ได้กรอก", true);
      }
      if (!res.ok || !json?.ok) {
        throw new AdminApiError(json?.reason ?? `เกิดข้อผิดพลาด (HTTP ${res.status})`);
      }
      return json;
    },
    [adminToken]
  );

  // ---- Module catalog (public GET) ----------------------------------------
  const [modules, setModules] = useState<ModuleCatalogItem[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/module-catalog");
        const json = await res.json();
        if (!json.ok) throw new Error(json.reason ?? "โหลดโมดูลไม่สำเร็จ");
        if (!cancelled) setModules(json.modules ?? []);
      } catch (err) {
        if (!cancelled)
          setCatalogError(err instanceof Error ? err.message : "โหลดโมดูลไม่สำเร็จ");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Step 1 state: create tenant ----------------------------------------
  const [tenantName, setTenantName] = useState("");
  const [planTier, setPlanTier] = useState<PlanTier>("starter");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Track whether the user hand-edited the checkboxes; if not, we auto-sync the
  // "included in this tier" defaults whenever the tier changes.
  const [keysTouched, setKeysTouched] = useState(false);

  const includedForTier = useCallback(
    (tier: PlanTier) =>
      modules
        .filter((m) => m.is_core || TIER_RANK[m.tier_min] <= TIER_RANK[tier])
        .map((m) => m.module_key),
    [modules]
  );

  // Pre-check tier-included modules once the catalog loads (and when tier changes,
  // as long as the user hasn't manually customized the selection).
  useEffect(() => {
    if (modules.length === 0 || keysTouched) return;
    setSelectedKeys(new Set(includedForTier(planTier)));
  }, [modules, planTier, keysTouched, includedForTier]);

  const toggleKey = (key: string, isCore: boolean) => {
    if (isCore) return; // core modules are always granted, not togglable
    setKeysTouched(true);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const [creatingTenant, setCreatingTenant] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<CreatedTenant | null>(null);
  const [grantedKeys, setGrantedKeys] = useState<string[]>([]);

  const submitTenant = async () => {
    setTenantError(null);
    if (!adminToken.trim()) {
      setTenantError("กรุณากรอก Admin Token ด้านบนก่อน");
      return;
    }
    if (!tenantName.trim()) {
      setTenantError("กรุณากรอกชื่อร้าน/ลูกค้า");
      return;
    }
    setCreatingTenant(true);
    try {
      const json = await adminFetch("/api/admin/tenants", {
        method: "POST",
        body: JSON.stringify({
          name: tenantName.trim(),
          plan_tier: planTier,
          module_keys: Array.from(selectedKeys),
        }),
      });
      setTenant(json.tenant as CreatedTenant);
      setGrantedKeys(
        Array.isArray(json.subscriptions)
          ? json.subscriptions.map((s: { module_key: string }) => s.module_key)
          : []
      );
    } catch (err) {
      setTenantError(
        err instanceof AdminApiError && err.unauthorized
          ? err.message
          : err instanceof Error
          ? err.message
          : "สร้างลูกค้าไม่สำเร็จ"
      );
    } finally {
      setCreatingTenant(false);
    }
  };

  // ---- Step 2 state: connect LINE OA --------------------------------------
  const [botUserId, setBotUserId] = useState("");
  const [channelSecret, setChannelSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [replyMode, setReplyMode] = useState<GroupReplyMode>("mention_only");
  const [creatingBot, setCreatingBot] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [botDone, setBotDone] = useState(false);

  const submitBot = async () => {
    setBotError(null);
    if (!tenant) {
      setBotError("ต้องสร้างลูกค้าใน Step 1 ก่อน");
      return;
    }
    if (!botUserId.trim() || !channelSecret.trim() || !accessToken.trim()) {
      setBotError("กรุณากรอก Bot User ID, Channel Secret และ Channel Access Token ให้ครบ");
      return;
    }
    setCreatingBot(true);
    try {
      await adminFetch("/api/admin/bots", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenant.id,
          line_channel_id: botUserId.trim(),
          channel_secret: channelSecret.trim(),
          access_token: accessToken.trim(),
          group_reply_mode: replyMode,
        }),
      });
      setBotDone(true);
    } catch (err) {
      setBotError(
        err instanceof AdminApiError && err.unauthorized
          ? err.message
          : err instanceof Error
          ? err.message
          : "เชื่อมต่อ LINE OA ไม่สำเร็จ"
      );
    } finally {
      setCreatingBot(false);
    }
  };

  // ---- Step 3: webhook URL + copy -----------------------------------------
  const webhookUrl = useMemo(
    () => (typeof window !== "undefined" ? `${window.location.origin}/api/line/webhook` : ""),
    []
  );
  const [copied, setCopied] = useState(false);
  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const grantedModuleNames = useMemo(() => {
    const byKey = new Map(modules.map((m) => [m.module_key, m.name]));
    return grantedKeys.map((k) => byKey.get(k) ?? k);
  }, [grantedKeys, modules]);

  const step1Done = !!tenant;
  const step2Done = botDone;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: COLORS.pageBg,
        fontFamily: FONT,
        color: COLORS.textMain,
        padding: "32px 24px 80px",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <header>
          <a
            href="/dashboard"
            style={{ color: COLORS.textMuted, fontSize: 13, textDecoration: "none" }}
          >
            ← กลับไป Dashboard
          </a>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: "10px 0 4px" }}>
            เพิ่มลูกค้าใหม่ — Onboarding
          </h1>
          <p style={{ color: COLORS.textMuted, margin: 0, fontSize: 14 }}>
            สร้างลูกค้า → เชื่อมต่อ LINE OA → วาง Webhook URL เดียว ใช้ได้กับลูกค้าทุกราย
          </p>
        </header>

        {/* Admin token */}
        <Panel>
          <Label>Admin Token</Label>
          <TextInput
            type="password"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            placeholder="วาง ADMIN_TOKEN ที่นี่"
            autoComplete="off"
          />
          <Help>
            <span style={{ color: COLORS.gold }}>จำเป็น</span> — ส่งเป็น header{" "}
            <code style={{ color: COLORS.blue }}>x-admin-token</code>{" "}
            ในทุกคำขอ Admin เก็บไว้ในเบราว์เซอร์นี้ (localStorage) แล้ว
          </Help>
        </Panel>

        {catalogError && <Banner kind="error">โหลดรายการโมดูลไม่สำเร็จ: {catalogError}</Banner>}

        {/* ---- Step 1 ---- */}
        <Panel active={!step1Done}>
          <StepHeader
            n={1}
            done={step1Done}
            title="สร้างลูกค้า (Tenant)"
            subtitle="ตั้งชื่อ เลือกแพ็กเกจ และเลือกโมดูลที่จะให้สิทธิ์"
          />

          {!step1Done ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <Label>ชื่อร้าน / ลูกค้า</Label>
                <TextInput
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  placeholder="เช่น ร้านนุ่น"
                />
              </div>

              <div>
                <Label>แพ็กเกจ (Plan Tier)</Label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {PLAN_TIERS.map((tier) => {
                    const on = planTier === tier;
                    return (
                      <button
                        key={tier}
                        type="button"
                        onClick={() => {
                          setPlanTier(tier);
                          setKeysTouched(false); // re-sync included defaults for new tier
                        }}
                        style={{
                          flex: "1 1 120px",
                          padding: "10px 12px",
                          borderRadius: 10,
                          fontSize: 14,
                          fontWeight: 700,
                          fontFamily: FONT,
                          cursor: "pointer",
                          textTransform: "capitalize",
                          background: on ? "var(--primary-weak)" : "var(--surface-2)",
                          color: on ? COLORS.blue : COLORS.textMuted,
                          border: `1px solid ${on ? COLORS.blue : COLORS.border}`,
                        }}
                      >
                        {tier}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <Label>โมดูลที่ให้สิทธิ์</Label>
                <Help>
                  โมดูลที่รวมในแพ็กเกจนี้ถูกติ๊กไว้ให้แล้ว ติ๊กเพิ่มเพื่อซื้อแบบ à la carte
                </Help>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  {modules.map((m) => {
                    const checked = m.is_core || selectedKeys.has(m.module_key);
                    const included =
                      m.is_core || TIER_RANK[m.tier_min] <= TIER_RANK[planTier];
                    const highlight = m.module_key === HIGHLIGHT_KEY;
                    return (
                      <label
                        key={m.module_key}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 12px",
                          borderRadius: 10,
                          cursor: m.is_core ? "default" : "pointer",
                          background: "var(--surface-2)",
                          border: `1px solid ${highlight ? COLORS.gold + "66" : COLORS.border}`,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={m.is_core}
                          onChange={() => toggleKey(m.module_key, m.is_core)}
                          style={{ width: 17, height: 17, accentColor: COLORS.blue, cursor: "inherit" }}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: highlight ? COLORS.gold : COLORS.textMain,
                            }}
                          >
                            {m.name}
                            {highlight && (
                              <span
                                style={{
                                  marginLeft: 8,
                                  fontSize: 10,
                                  fontWeight: 700,
                                  background: COLORS.gold,
                                  color: "var(--primary-fg)",
                                  padding: "2px 7px",
                                  borderRadius: 999,
                                }}
                              >
                                แนะนำ
                              </span>
                            )}
                          </span>
                          <span
                            style={{
                              display: "block",
                              fontSize: 12,
                              color: COLORS.textMuted,
                              marginTop: 2,
                            }}
                          >
                            Tier ขั้นต่ำ: <span style={{ textTransform: "capitalize" }}>{m.tier_min}</span>
                            {" · "}
                            {m.is_core
                              ? "โมดูลหลัก (รวมเสมอ)"
                              : m.addon_price_thb != null
                              ? `฿${m.addon_price_thb.toLocaleString("th-TH")} / เดือน`
                              : "ราคาติดต่อฝ่ายขาย"}
                          </span>
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: included ? COLORS.green : COLORS.textMuted,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {included ? "รวมในแพ็กเกจ" : "add-on"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {tenantError && <Banner kind="error">{tenantError}</Banner>}

              <div>
                <Button onClick={submitTenant} disabled={creatingTenant}>
                  {creatingTenant ? "กำลังสร้าง..." : "สร้างลูกค้า →"}
                </Button>
              </div>
            </div>
          ) : (
            <Banner kind="success">
              สร้างลูกค้า <strong>{tenant.name}</strong> สำเร็จ · Tenant ID:{" "}
              <code style={{ color: COLORS.textMain }}>{tenant.id}</code>
            </Banner>
          )}
        </Panel>

        {/* ---- Step 2 ---- */}
        <Panel active={step1Done && !step2Done} style={{ opacity: step1Done ? undefined : 0.55 }}>
          <StepHeader
            n={2}
            done={step2Done}
            title="เชื่อมต่อ LINE OA ของลูกค้า"
            subtitle="กรอกข้อมูล Messaging API — Secret/Token จะถูกเข้ารหัส ไม่ถูกส่งกลับ"
          />

          {!step1Done ? (
            <Help>สร้างลูกค้าใน Step 1 ให้เสร็จก่อน</Help>
          ) : !step2Done ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <Label>Bot User ID (destination)</Label>
                <TextInput
                  value={botUserId}
                  onChange={(e) => setBotUserId(e.target.value)}
                  placeholder="U0a1b2c3..."
                />
                <Help>
                  หาได้ใน LINE Developers console &gt; Messaging API &gt; Bot user ID, ขึ้นต้นด้วย{" "}
                  <code style={{ color: COLORS.blue }}>U</code> — ค่านี้คือ{" "}
                  <code style={{ color: COLORS.blue }}>destination</code> ที่ LINE ส่งมาใน webhook
                  ใช้ route ไปยังลูกค้าที่ถูกต้อง
                </Help>
              </div>

              <div>
                <Label>Channel Secret</Label>
                <TextInput
                  type="password"
                  value={channelSecret}
                  onChange={(e) => setChannelSecret(e.target.value)}
                  placeholder="channel secret"
                  autoComplete="off"
                />
              </div>

              <div>
                <Label>Channel Access Token</Label>
                <TextInput
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="long-lived access token"
                  autoComplete="off"
                />
              </div>

              <div>
                <Label>โหมดตอบในกลุ่ม (Group Reply Mode)</Label>
                <Select
                  value={replyMode}
                  onChange={(e) => setReplyMode(e.target.value as GroupReplyMode)}
                >
                  <option value="mention_only">mention_only — ตอบเมื่อถูก @ เท่านั้น</option>
                  <option value="prefix">prefix — ตอบเมื่อขึ้นต้นด้วยเครื่องหมายที่ตั้งไว้</option>
                  <option value="all">all — ตอบทุกข้อความในกลุ่ม</option>
                </Select>
              </div>

              {botError && <Banner kind="error">{botError}</Banner>}

              <div>
                <Button onClick={submitBot} disabled={creatingBot}>
                  {creatingBot ? "กำลังเชื่อมต่อ..." : "เชื่อมต่อ LINE OA →"}
                </Button>
              </div>
            </div>
          ) : (
            <Banner kind="success">เชื่อมต่อ LINE OA สำเร็จ</Banner>
          )}
        </Panel>

        {/* ---- Step 3 ---- */}
        <Panel active={step2Done} style={{ opacity: step2Done ? undefined : 0.55 }}>
          <StepHeader
            n={3}
            done={step2Done}
            title="เสร็จสิ้น — วาง Webhook URL"
            subtitle="URL เดียวนี้ใช้ได้กับลูกค้าทุกราย"
          />

          {!step2Done ? (
            <Help>เชื่อมต่อ LINE OA ใน Step 2 ให้เสร็จก่อน</Help>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <Label>Webhook URL</Label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <code
                    style={{
                      flex: "1 1 320px",
                      minWidth: 0,
                      padding: "11px 12px",
                      borderRadius: 10,
                      background: "var(--primary-weak)",
                      border: `1px solid ${COLORS.blue}55`,
                      color: COLORS.textMain,
                      fontSize: 13,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {webhookUrl}
                  </code>
                  <Button variant={copied ? "gold" : "primary"} onClick={copyWebhook}>
                    {copied ? "คัดลอกแล้ว ✓" : "คัดลอก"}
                  </Button>
                </div>
              </div>

              <Banner kind="info">
                วาง URL นี้ในช่อง Webhook URL ของ LINE OA ลูกค้า แล้วเปิด Use webhook —
                ลูกค้าใช้งานได้ทันทีตามโมดูลที่ให้สิทธิ์
              </Banner>

              <div>
                <Label>โมดูลที่ให้สิทธิ์กับลูกค้ารายนี้</Label>
                {grantedModuleNames.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                    {grantedModuleNames.map((name) => (
                      <span
                        key={name}
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: COLORS.green,
                          background: "var(--success-weak)",
                          border: `1px solid ${COLORS.green}44`,
                          borderRadius: 999,
                          padding: "5px 12px",
                        }}
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <Help>ยังไม่ได้ให้สิทธิ์โมดูลใด (มีเฉพาะโมดูลหลัก)</Help>
                )}
              </div>

              <div>
                <Button
                  variant="ghost"
                  onClick={() => window.location.reload()}
                  style={{ alignSelf: "flex-start" }}
                >
                  + เพิ่มลูกค้าอีกราย
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}
