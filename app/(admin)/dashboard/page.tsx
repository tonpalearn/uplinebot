"use client";

// Admin Dashboard — Module Catalog (SPEC.md §6.2, §6, §7).
// TODO: still missing per §6.2 — Bot/Channel Manager, Logs & Analytics,
// Free Trial banner, Guided Onboarding checklist. This pass covers the
// Module Catalog UI (toggle+buy) only.

import { useEffect, useState } from "react";
import ModuleCatalogCard, {
  type ModuleCatalogItem,
} from "./components/ModuleCatalogCard";

// TODO: hardcoded tenant id for this pass — replace with the tenant id
// derived from the authenticated admin session once Supabase Auth is wired
// up on the Dashboard (see app/api/admin/subscriptions/route.ts note).
const TENANT_ID_TODO = "00000000-0000-0000-0000-000000000001";

const COLORS = {
  pageBg: "#0a0e17",
  textMain: "#eef1f7",
  textMuted: "#8b93a7",
  blue: "#4da3ff",
  green: "#37e2b0",
};

export default function DashboardPage() {
  const [modules, setModules] = useState<ModuleCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch("/api/admin/module-catalog");
        const json = await res.json();
        if (!json.ok) {
          throw new Error(json.reason ?? "โหลดข้อมูลไม่สำเร็จ");
        }
        if (!cancelled) {
          setModules(json.modules ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnable = async (moduleKey: string) => {
    const res = await fetch("/api/admin/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: TENANT_ID_TODO,
        module_key: moduleKey,
        billing_mode: "addon",
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      return { ok: false, reason: json.reason ?? "เปิดใช้งานไม่สำเร็จ" };
    }
    return { ok: true };
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: COLORS.pageBg,
        fontFamily:
          "'IBM Plex Sans Thai', 'Noto Sans Thai', system-ui, sans-serif",
        color: COLORS.textMain,
        padding: "32px 24px 64px",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <header style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>
                UP Line — Admin Dashboard
              </h1>
              <p style={{ color: COLORS.textMuted, marginTop: 6, fontSize: 14 }}>
                Module Catalog — เปิด/ปิดและซื้อโมดูลเพิ่มแบบ à la carte
              </p>
            </div>
            <div style={{ flex: "0 0 auto", display: "flex", gap: 10 }}>
              <a
                href="/guide.html"
                target="_blank"
                rel="noopener"
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.06)",
                  border: `1px solid rgba(255,255,255,0.12)`,
                  color: COLORS.textMain,
                  fontWeight: 700,
                  fontSize: 14,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                📖 คู่มือลูกค้า
              </a>
              <a
                href="/customers"
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.06)",
                  border: `1px solid rgba(255,255,255,0.12)`,
                  color: COLORS.textMain,
                  fontWeight: 700,
                  fontSize: 14,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                จัดการลูกค้า
              </a>
              <a
                href="/onboarding"
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  background: COLORS.blue,
                  color: "#0a0e17",
                  fontWeight: 700,
                  fontSize: 14,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                + เพิ่มลูกค้าใหม่
              </a>
            </div>
          </div>
          <p style={{ color: "#665a33", background: "rgba(242,193,78,0.08)", display: "inline-block", marginTop: 10, padding: "4px 10px", borderRadius: 8, fontSize: 12 }}>
            TODO: ใช้ hardcoded tenant_id ชั่วคราว — รอผูก Supabase Auth session จริง
          </p>
        </header>

        {loading && <p style={{ color: COLORS.textMuted }}>กำลังโหลดโมดูล...</p>}

        {loadError && (
          <p style={{ color: "#ff6b6b" }}>โหลดโมดูลไม่สำเร็จ: {loadError}</p>
        )}

        {!loading && !loadError && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {modules.map((m) => (
              <ModuleCatalogCard key={m.module_key} module={m} onEnable={handleEnable} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
