"use client";

// Small shared UI primitives + design tokens for the onboarding wizard.
// Dark glass, matching the admin dashboard (bg #0a0e17, accent #4da3ff, green #37e2b0, gold #f2c14e).

import type { CSSProperties, ReactNode } from "react";

export const COLORS = {
  pageBg: "var(--bg)",
  cardBg: "var(--surface)",
  border: "var(--border)",
  textMain: "var(--fg)",
  textMuted: "var(--muted)",
  blue: "var(--primary)",
  green: "var(--success)",
  gold: "var(--gold)",
  danger: "var(--danger)",
} as const;

export const FONT = "var(--font-sans)";

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
        border: `1px solid ${active ? "var(--primary)" : COLORS.border}`,
        boxShadow: active
          ? "0 0 0 1px var(--primary-weak), 0 8px 24px rgba(0,0,0,0.35)"
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
          background: done ? COLORS.green : "var(--primary-weak)",
          color: done ? "var(--primary-fg)" : COLORS.blue,
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
  background: "var(--surface-2)",
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
    variant === "gold" ? COLORS.gold : variant === "ghost" ? "var(--surface-2)" : COLORS.blue;
  const fg = variant === "ghost" ? COLORS.textMain : "var(--primary-fg)";
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
    error: { c: COLORS.danger, bg: "var(--danger-weak)" },
    success: { c: COLORS.green, bg: "var(--success-weak)" },
    info: { c: COLORS.blue, bg: "var(--primary-weak)" },
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
