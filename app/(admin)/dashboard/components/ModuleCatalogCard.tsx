"use client";

export interface ModuleCatalogItem {
  module_key: string;
  name: string;
  requires_api_key: boolean;
  tier_min: string;
  addon_price_thb: number | null;
  is_core: boolean;
}

// Module highlighted per SPEC.md §6.5 — validated top-priority module.
const HIGHLIGHT_KEY = "slip_verification";

const COLORS = {
  bg: "var(--surface)",
  border: "var(--border)",
  gold: "var(--gold)",
  blue: "var(--primary)",
  green: "var(--success)",
  textMuted: "var(--muted)",
  textMain: "var(--fg)",
};

/**
 * Read-only catalog card. Enabling a module is per-CUSTOMER and lives on the
 * "จัดการลูกค้า" (/customers) page (needs a tenant + the admin token), so this card
 * only displays the module + tier + price.
 */
export default function ModuleCatalogCard({ module }: { module: ModuleCatalogItem }) {
  const isHighlight = module.module_key === HIGHLIGHT_KEY;

  return (
    <div
      style={{
        position: "relative",
        borderRadius: 16,
        padding: 20,
        background: COLORS.bg,
        border: isHighlight ? `1px solid ${COLORS.gold}` : `1px solid ${COLORS.border}`,
        boxShadow: isHighlight
          ? "0 0 0 1px rgba(242,193,78,0.25), 0 8px 24px rgba(242,193,78,0.08)"
          : "0 4px 16px rgba(0,0,0,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 200,
      }}
    >
      {isHighlight && (
        <span
          style={{
            position: "absolute",
            top: -10,
            right: 16,
            background: COLORS.gold,
            color: "var(--primary-fg)",
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 10px",
            borderRadius: 999,
            letterSpacing: 0.3,
          }}
        >
          แนะนำ
        </span>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <h3
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: isHighlight ? COLORS.gold : COLORS.textMain,
          }}
        >
          {module.name}
        </h3>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.blue,
            border: `1px solid ${COLORS.blue}`,
            borderRadius: 999,
            padding: "2px 8px",
            whiteSpace: "nowrap",
          }}
        >
          Tier: {module.tier_min}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: COLORS.textMuted }}>
        <span>
          {module.requires_api_key ? "🔑 ต้องต่อ API Key ภายนอก" : "✅ ไม่ต้องต่อ API Key"}
        </span>
        <span style={{ color: COLORS.green, fontWeight: 600 }}>
          {module.is_core
            ? "รวมในราคาฐาน"
            : module.addon_price_thb != null
            ? `฿${module.addon_price_thb.toLocaleString("th-TH")} / เดือน`
            : "ราคาติดต่อฝ่ายขาย"}
        </span>
      </div>

      <div
        style={{
          marginTop: "auto",
          fontSize: 12,
          color: COLORS.textMuted,
          borderTop: `1px solid ${COLORS.border}`,
          paddingTop: 10,
        }}
      >
        {module.is_core
          ? "รวมอยู่ในระบบทุกลูกค้า"
          : "เปิดให้ลูกค้าที่หน้า “จัดการลูกค้า”"}
      </div>
    </div>
  );
}
