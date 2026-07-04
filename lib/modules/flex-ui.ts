/**
 * Shared Flex design-token system for every module card (todo, expense, …).
 *
 * WHY this file exists: each module used to hardcode its own palette + font sizes, so the
 * cards drifted apart — todo AND expense both ended up green, and text was almost all
 * sm/xs/xxs (tiny). This centralizes ONE premium type scale + a per-module ACCENT so a
 * "todo card" is unmistakably RED and a "money card" is unmistakably GREEN, while both
 * share the same readable typography (the sizing ต้น liked on the Euneun cards).
 *
 * LINE Flex CONSTRAINTS (why this is NOT CSS/Tailwind/real glass):
 *   • No backdrop-blur / box-shadow / real transparency → true frosted "glass" is impossible.
 *   • Colors are FIXED hex — Flex can't read CSS vars or the app theme. The theme-aware
 *     surface is the web report page (/ledger, /plan), not the in-chat card.
 *   • "Premium" here = linearGradient headers + cornerRadius + a refined type scale.
 * A Box DOES support `background: { type:"linearGradient", angle, startColor, endColor }` —
 * that gradient is what gives each card its colored, depth-y header.
 */

// ── type scale (LINE keyword sizes; bumped up for readability — the "Euneun" feel) ─────
// keyword → approx px on LINE: xxs 11 · xs 13 · sm 14 · md 16 · lg 19 · xl 22 · xxl 29
export const FS = {
  hero: "xxl", // the single big number (net balance)
  title: "xl", // card title in the gradient header
  section: "md", // section heading inside the body ("รายจ่ายแยกหมวด")
  body: "md", // primary row text (task / item name) — was sm
  label: "md", // row label (รายรับ/รายจ่าย)
  meta: "sm", // secondary line (category, count, due) — was xs/xxs
  caption: "xs", // smallest useful text (bar %)
} as const;

// ── neutrals (shared light card body) ─────────────────────────────────────────────────
export const NEUTRAL = {
  text: "#1F2933", // charcoal — primary text on white body
  muted: "#7B8794", // secondary/label text
  sep: "#E8ECF0", // separators + dimmed chip bg
  track: "#EEF1F4", // bar-graph track (empty portion)
  bodyBg: "#FFFFFF",
  footerBg: "#FAFBFC",
} as const;

// ── accent themes (the color-coded identity per module) ────────────────────────────────
export interface AccentTheme {
  gradStart: string; // header gradient (top-left)
  gradEnd: string; // header gradient (bottom-right)
  solid: string; // solid fallback + web button + small accents
  onAccent: string; // strong text on the gradient (title / hero number)
  onAccentMuted: string; // secondary text on the gradient (eyebrow / count)
  chipBg: string; // number-chip background (sits on the white body)
  chipText: string; // number-chip text
}

/** TODO = RED / rose — urgency, action. */
export const TODO_ACCENT: AccentTheme = {
  gradStart: "#F43F5E", // rose-500
  gradEnd: "#BE123C", // rose-700
  solid: "#E11D48", // rose-600
  onAccent: "#FFFFFF",
  onAccentMuted: "#FFE4E6", // rose-100
  chipBg: "#FFE4E6",
  chipText: "#BE123C",
};

/** MONEY = GREEN / emerald — the รายรับ-รายจ่าย (bookkeeping) identity. */
export const MONEY_ACCENT: AccentTheme = {
  gradStart: "#10B981", // emerald-500
  gradEnd: "#047857", // emerald-700
  solid: "#059669", // emerald-600
  onAccent: "#FFFFFF",
  onAccentMuted: "#D1FAE5", // emerald-100
  chipBg: "#D1FAE5",
  chipText: "#047857",
};

/** Money DIRECTION colors — semantic, independent of the header accent. */
export const MONEY = {
  income: "#059669", // green (+)
  expense: "#DC2626", // red (−)
} as const;

/** Category-bar palette (harmonized; greens/teals lead, then blue/amber/violet/…). */
export const BAR_COLORS = [
  "#10B981",
  "#0EA5E9",
  "#F59E0B",
  "#8B5CF6",
  "#EF4444",
  "#14B8A6",
  "#EAB308",
  "#84CC16",
];

// ── builders ───────────────────────────────────────────────────────────────────────────

export interface HeaderOpts {
  accent: AccentTheme;
  /** small line ABOVE everything (e.g. period "📊 วันนี้ 4 ก.ค."). */
  eyebrow?: string;
  /** bold title line (e.g. "📋 รายการงาน"). Optional for number-led cards. */
  title?: string;
  /** small label directly above the hero number (e.g. "คงเหลือ"). */
  heroLabel?: string;
  /** the big number line (e.g. net balance "+1,234 ฿"). */
  hero?: string;
  /** small line UNDER everything (e.g. count "12 รายการ"). */
  subtitle?: string;
}

/**
 * The colored gradient header — the premium, depth-y top of every card. Renders, in order:
 * eyebrow → title → heroLabel → hero → subtitle, all in the accent's on-colors so they read
 * on the gradient. Use as the bubble's `header`, and pair with headerStyle() for the solid
 * fallback on renderers that ignore gradients.
 */
export function gradientHeader(opts: HeaderOpts): Record<string, unknown> {
  const { accent } = opts;
  const contents: Record<string, unknown>[] = [];

  if (opts.eyebrow) {
    contents.push({ type: "text", text: opts.eyebrow, size: FS.meta, color: accent.onAccentMuted });
  }
  if (opts.title) {
    contents.push({
      type: "text",
      text: opts.title,
      size: FS.title,
      weight: "bold",
      color: accent.onAccent,
      wrap: true,
      margin: opts.eyebrow ? "xs" : "none",
    });
  }
  if (opts.heroLabel) {
    contents.push({ type: "text", text: opts.heroLabel, size: FS.meta, color: accent.onAccentMuted, margin: "md" });
  }
  if (opts.hero) {
    contents.push({
      type: "text",
      text: opts.hero,
      size: FS.hero,
      weight: "bold",
      color: accent.onAccent,
      margin: opts.heroLabel ? "xs" : "sm",
    });
  }
  if (opts.subtitle) {
    contents.push({ type: "text", text: opts.subtitle, size: FS.meta, color: accent.onAccentMuted, margin: "sm" });
  }

  return {
    type: "box",
    layout: "vertical",
    paddingAll: "20px",
    paddingBottom: "16px",
    spacing: "none",
    background: {
      type: "linearGradient",
      angle: "135deg",
      startColor: accent.gradStart,
      endColor: accent.gradEnd,
    },
    contents,
  };
}

/** styles.header fallback (solid) for renderers that don't support the gradient. */
export function headerStyle(accent: AccentTheme): Record<string, unknown> {
  return { backgroundColor: accent.gradStart };
}

/** styles.footer for the soft off-white footer bar. */
export function footerStyle(): Record<string, unknown> {
  return { backgroundColor: NEUTRAL.footerBg };
}

/** Rounded number chip (leading number on a todo/ledger row). `dimmed` = greyed (done). */
export function numberChip(n: number | string, accent: AccentTheme, dimmed = false): Record<string, unknown> {
  return {
    type: "box",
    layout: "vertical",
    width: "30px",
    height: "30px",
    cornerRadius: "15px",
    justifyContent: "center",
    backgroundColor: dimmed ? NEUTRAL.sep : accent.chipBg,
    contents: [
      {
        type: "text",
        text: String(n),
        size: FS.meta,
        weight: "bold",
        align: "center",
        color: dimmed ? NEUTRAL.muted : accent.chipText,
      },
    ],
  };
}

/** Soft separator line in the shared neutral tone. */
export function softSep(margin = "md"): Record<string, unknown> {
  return { type: "separator", margin, color: NEUTRAL.sep };
}

/** Primary footer button that opens a URL. */
export function primaryButton(label: string, uri: string, color: string): Record<string, unknown> {
  return {
    type: "button",
    style: "primary",
    color,
    height: "sm",
    action: { type: "uri", label, uri },
  };
}
