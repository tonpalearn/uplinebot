"use client";

// Small shared UI primitives + design tokens for the onboarding wizard.
// Dark glass, matching the admin dashboard (bg #0a0e17, accent #4da3ff, green #37e2b0, gold #f2c14e).

import type { CSSProperties, ReactNode } from "react";

export const COLORS = {
  pageBg: "#0a0e17",
  cardBg: "#0f1420",
  border: "rgba(255,255,255,0.08)",
  textMain: "#eef1f7",
  textMuted: "#8b93a7",
  blue: "#4da3ff",
  green: "#37e2b0",
  gold: "#f2c14e",
  danger: "#ff6b6b",
} as const;

export const FONT =
  "'IBM Plex Sans Thai', 'Noto Sans Thai', system-ui, sans-serif";

// A glass panel used for each wizard step.
export function Panel({
  children,
  active,
  style,
}: {
  children: ReactNode;
  active?: boolean;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        borderRadius: 16,
        padding: 24,
        background: COLORS.cardBg,
        border: `1px solid ${active ? "rgba(77,163,255,0.35)" : COLORS.border}`,
        boxShadow: active
          ? "0 0 0 1px rgba(77,163,255,0.18), 0 8px 24px rgba(0,0,0,0.35)"
          : "0 4px 16px rgba(0,0,0,0.25)",
        opacity: active === false ? 0.55 : 1,
        transition: "opacity .2s, border-color .2s",
        ...style,
      }}
    >
      {children}
    </section>
  );
}

// Step header with a numbered badge.
export function StepHeader({
  n,
  title,
  subtitle,
  done,
}: {
  n: number;
  title: string;
  subtitle?: string;
  done?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
      <span
        style={{
          flex: "0 0 auto",
          width: 30,
          height: 30,
          borderRadius: 999,
          display: "grid",
          placeItems: "center",
          fontSize: 14,
          fontWeight: 700,
          background: done ? COLORS.green : "rgba(77,163,255,0.15)",
          color: done ? "#0a0e17" : COLORS.blue,
          border: done ? "none" : `1px solid ${COLORS.blue}`,
        }}
      >
        {done ? "✓" : n}
      </span>
      <div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.textMain }}>
          {title}
        </h2>
        {subtitle && (
          <p style={{ margin: "4px 0 0", fontSize: 13, color: COLORS.textMuted }}>{subtitle}</p>
        )}
      </div>
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: 13,
        fontWeight: 600,
        color: COLORS.textMain,
        marginBottom: 6,
      }}
    >
      {children}
    </label>
  );
}

export function Help({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: "4px 0 0", fontSize: 12, color: COLORS.textMuted, lineHeight: 1.5 }}>
      {children}
    </p>
  );
}

const fieldStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(255,255,255,0.04)",
  color: COLORS.textMain,
  fontFamily: FONT,
  fontSize: 14,
  outline: "none",
};

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement>
) {
  return <input {...props} style={{ ...fieldStyle, ...(props.style || {}) }} />;
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }
) {
  const { children, style, ...rest } = props;
  return (
    <select {...rest} style={{ ...fieldStyle, ...(style || {}) }}>
      {children}
    </select>
  );
}

export function Button({
  children,
  variant = "primary",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "gold" | "ghost";
}) {
  const disabled = rest.disabled;
  const bg =
    variant === "gold" ? COLORS.gold : variant === "ghost" ? "rgba(255,255,255,0.06)" : COLORS.blue;
  const fg = variant === "ghost" ? COLORS.textMain : "#0a0e17";
  return (
    <button
      {...rest}
      style={{
        padding: "11px 18px",
        borderRadius: 10,
        border: variant === "ghost" ? `1px solid ${COLORS.border}` : "none",
        fontWeight: 700,
        fontSize: 14,
        fontFamily: FONT,
        cursor: disabled ? "not-allowed" : "pointer",
        background: bg,
        color: fg,
        opacity: disabled ? 0.55 : 1,
        ...(rest.style || {}),
      }}
    >
      {children}
    </button>
  );
}

// Inline status / error banner.
export function Banner({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  const map = {
    error: { c: COLORS.danger, bg: "rgba(255,107,107,0.1)" },
    success: { c: COLORS.green, bg: "rgba(55,226,176,0.1)" },
    info: { c: COLORS.blue, bg: "rgba(77,163,255,0.1)" },
  }[kind];
  return (
    <div
      style={{
        fontSize: 13,
        color: map.c,
        background: map.bg,
        border: `1px solid ${map.c}33`,
        borderRadius: 10,
        padding: "10px 12px",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
