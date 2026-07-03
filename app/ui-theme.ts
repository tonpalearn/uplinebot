// Shared token references for inline styles. Every value is a `var(--token)` that
// resolves against globals.css, so any component using `T.*` flips with the theme
// and scales with the font control automatically. Keep names in sync with globals.css.

export const T = {
  bg: "var(--bg)",
  surface: "var(--surface)",
  surface2: "var(--surface-2)",
  surfaceGlass: "var(--surface-glass)",
  fg: "var(--fg)",
  fgStrong: "var(--fg-strong)",
  muted: "var(--muted)",
  muted2: "var(--muted-2)",
  border: "var(--border)",
  borderStrong: "var(--border-strong)",

  primary: "var(--primary)",
  primaryHover: "var(--primary-hover)",
  primaryWeak: "var(--primary-weak)",
  primaryFg: "var(--primary-fg)",

  accent: "var(--accent)",
  accentHover: "var(--accent-hover)",
  accentWeak: "var(--accent-weak)",
  accentFg: "var(--accent-fg)",

  success: "var(--success)",
  successWeak: "var(--success-weak)",
  danger: "var(--danger)",
  dangerWeak: "var(--danger-weak)",
  warning: "var(--warning)",
  gold: "var(--gold)",
  goldRing: "var(--gold-ring)",

  ring: "var(--ring)",
  overlay: "var(--overlay)",

  shadowSm: "var(--shadow-sm)",
  shadowMd: "var(--shadow-md)",
  shadowLg: "var(--shadow-lg)",
  shadowPrimary: "var(--shadow-primary)",

  radiusSm: "var(--radius-sm)",
  radius: "var(--radius)",
  radiusLg: "var(--radius-lg)",
  radiusPill: "var(--radius-pill)",
} as const;
