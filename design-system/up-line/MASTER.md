# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** UP Line
**Generated:** 2026-07-03 17:17:09
**Category:** General

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#2563EB` | `--color-primary` |
| Secondary | `#3B82F6` | `--color-secondary` |
| Accent/CTA | `#F97316` | `--color-accent` |
| Background | `#F8FAFC` | `--color-background` |
| Foreground | `#1E293B` | `--color-foreground` |

### Typography

- **Heading Font:** Inter
- **Body Font:** Inter
- **Mood:** Professional + Hierarchy

---

## Style Guidelines

**Style:** Minimalism

**Key Effects:** Subtle hover (200-250ms) + Smooth transitions

### Page Pattern

**Pattern Name:** Hero + Features + CTA

- **Section Order:** Hero > Features > CTA

---

## Anti-Patterns (Do NOT Use)

- ❌ Excessive animation
- ❌ Dark mode by default

---

## Pre-Delivery Checklist

- [ ] No emojis used as icons (use SVG instead)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
