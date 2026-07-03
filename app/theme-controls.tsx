"use client";

import { useEffect, useRef, useState } from "react";
import { T } from "./ui-theme";

/* Preference model — matches the no-flash script in layout.tsx.
 * theme: what the user picked (may be "system"); we resolve it to a concrete
 * data-theme on <html>. font: a label mapped to the numeric --fs scale. */
type ThemePref = "light" | "dark" | "system";
type FontPref = "sm" | "md" | "lg";

const THEME_KEY = "upl-theme";
const FONT_KEY = "upl-fs";
const FONT_SCALE: Record<FontPref, string> = { sm: "0.9", md: "1", lg: "1.15" };

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(pref: ThemePref) {
  const resolved = pref === "system" ? (systemDark() ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
}

function applyFont(pref: FontPref) {
  document.documentElement.style.setProperty("--fs", FONT_SCALE[pref]);
}

export default function ThemeControls() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>("system");
  const [font, setFont] = useState<FontPref>("md");
  const rootRef = useRef<HTMLDivElement>(null);

  // hydrate from storage (the no-flash script already applied it to the DOM)
  useEffect(() => {
    const t = (localStorage.getItem(THEME_KEY) as ThemePref) || "system";
    const f = (localStorage.getItem(FONT_KEY) as FontPref) || "md";
    setTheme(t);
    setFont(f);
    setMounted(true);
  }, []);

  // keep in sync with the OS while on "system"
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // close on outside click / Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickTheme = (t: ThemePref) => {
    setTheme(t);
    localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
  };
  const pickFont = (f: FontPref) => {
    setFont(f);
    localStorage.setItem(FONT_KEY, f);
    applyFont(f);
  };

  const seg: React.CSSProperties = {
    display: "flex",
    gap: 4,
    padding: 4,
    borderRadius: T.radius,
    background: T.surface2,
    border: `1px solid ${T.border}`,
  };
  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "8px 10px",
    borderRadius: "calc(var(--radius) - 5px)",
    border: "none",
    background: active ? T.surface : "transparent",
    color: active ? T.primary : T.muted,
    fontWeight: 700,
    fontSize: "0.8rem",
    boxShadow: active ? T.shadowSm : "none",
    transition: "background 0.18s ease, color 0.18s ease",
  });

  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        right: "max(16px, env(safe-area-inset-right))",
        bottom: "max(16px, env(safe-area-inset-bottom))",
        zIndex: 200,
        fontFamily: "var(--font-sans)",
      }}
    >
      {open && (
        <div
          role="dialog"
          aria-label="ตั้งค่าการแสดงผล"
          style={{
            position: "absolute",
            bottom: 58,
            right: 0,
            width: 268,
            padding: 16,
            borderRadius: T.radiusLg,
            background: T.surface,
            border: `1px solid ${T.border}`,
            boxShadow: T.shadowLg,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: T.muted, marginBottom: 8, letterSpacing: "0.02em" }}>
              ธีม
            </div>
            <div style={seg} role="group" aria-label="เลือกธีม">
              <button style={segBtn(mounted && theme === "light")} onClick={() => pickTheme("light")} aria-pressed={mounted && theme === "light"}>
                <SunIcon /> สว่าง
              </button>
              <button style={segBtn(mounted && theme === "dark")} onClick={() => pickTheme("dark")} aria-pressed={mounted && theme === "dark"}>
                <MoonIcon /> มืด
              </button>
              <button style={segBtn(mounted && theme === "system")} onClick={() => pickTheme("system")} aria-pressed={mounted && theme === "system"}>
                <AutoIcon /> ระบบ
              </button>
            </div>
          </div>

          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: T.muted, marginBottom: 8, letterSpacing: "0.02em" }}>
              ขนาดตัวอักษร
            </div>
            <div style={seg} role="group" aria-label="เลือกขนาดตัวอักษร">
              <button style={{ ...segBtn(mounted && font === "sm"), fontSize: "0.78rem" }} onClick={() => pickFont("sm")} aria-pressed={mounted && font === "sm"}>
                ก เล็ก
              </button>
              <button style={{ ...segBtn(mounted && font === "md"), fontSize: "0.92rem" }} onClick={() => pickFont("md")} aria-pressed={mounted && font === "md"}>
                ก กลาง
              </button>
              <button style={{ ...segBtn(mounted && font === "lg"), fontSize: "1.05rem" }} onClick={() => pickFont("lg")} aria-pressed={mounted && font === "lg"}>
                ก ใหญ่
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        aria-label="ตั้งค่าการแสดงผล (ธีม และ ขนาดตัวอักษร)"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 46,
          height: 46,
          borderRadius: T.radiusPill,
          background: T.surface,
          border: `1px solid ${T.border}`,
          boxShadow: T.shadowMd,
          color: T.fg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginLeft: "auto",
          transition: "transform 0.18s ease, box-shadow 0.18s ease",
        }}
      >
        <DisplayIcon />
      </button>
    </div>
  );
}

/* --- inline SVG icons (no emoji, per design checklist) --- */
const ico = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function SunIcon() {
  return (
    <svg {...ico} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg {...ico} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
function AutoIcon() {
  return (
    <svg {...ico} aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
function DisplayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.4v2.2M12 19.4v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.4 12h2.2M19.4 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </svg>
  );
}
