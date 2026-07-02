"use client";

import { useState } from "react";

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
  bg: "#0f1420",
  border: "rgba(255,255,255,0.08)",
  gold: "#f2c14e",
  blue: "#4da3ff",
  green: "#37e2b0",
  textMuted: "#8b93a7",
  textMain: "#eef1f7",
};

export default function ModuleCatalogCard({
  module,
  onEnable,
}: {
  module: ModuleCatalogItem;
  onEnable: (moduleKey: string) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isHighlight = module.module_key === HIGHLIGHT_KEY;

  const handleClick = async () => {
    setStatus("loading");
    setErrorMsg(null);
    try {
      const res = await onEnable(module.module_key);
      if (res.ok) {
        setStatus("success");
      } else {
        setStatus("error");
        setErrorMsg(res.reason ?? "เกิดข้อผิดพลาด");
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "เกิดข้อผิดพลาด");
    }
  };

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
            color: "#0a0e17",
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

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          onClick={handleClick}
          disabled={status === "loading" || module.is_core}
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 10,
            border: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: module.is_core ? "default" : "pointer",
            background: module.is_core
              ? "rgba(255,255,255,0.06)"
              : isHighlight
              ? COLORS.gold
              : COLORS.blue,
            color: module.is_core ? COLORS.textMuted : "#0a0e17",
            opacity: status === "loading" ? 0.6 : 1,
          }}
        >
          {module.is_core
            ? "รวมอยู่แล้ว"
            : status === "loading"
            ? "กำลังเปิดใช้งาน..."
            : "เปิดใช้งาน"}
        </button>

        {status === "success" && (
          <span style={{ fontSize: 12, color: COLORS.green }}>เปิดใช้งานสำเร็จ</span>
        )}
        {status === "error" && (
          <span style={{ fontSize: 12, color: "#ff6b6b" }}>ผิดพลาด: {errorMsg}</span>
        )}
      </div>
    </div>
  );
}
