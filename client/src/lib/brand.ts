import type { CSSProperties } from "react";

/** Picks white or ink text for a background colour using WCAG contrast. Mirrors src/emails/templates.ts. */
const INK = "#11181C";

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function readableTextOn(hex: string): string {
  return contrastRatio(hex, "#FFFFFF") >= contrastRatio(hex, INK) ? "#FFFFFF" : INK;
}

/** Minimum contrast against white so brand-coloured text and icons stay legible (WCAG 1.4.11). */
export const MIN_BRAND_CONTRAST = 3;

export const BRAND_PRESETS: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "Forest Pine", hex: "#0F5243" },
  { name: "Deep Navy", hex: "#1E3A5F" },
  { name: "Cobalt", hex: "#1D4ED8" },
  { name: "Indigo", hex: "#4338CA" },
  { name: "Slate", hex: "#334155" },
  { name: "Charcoal", hex: "#18181B" },
  { name: "Plum", hex: "#6D28D9" },
  { name: "Burgundy", hex: "#881337" },
  { name: "Burnt Sienna", hex: "#9A3412" },
  { name: "Teal", hex: "#0F766E" },
];

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!isHexColor(hex)) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((n) => n.toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;
}

/** CSS variables that re-theme shadcn tokens for a client-facing brand colour. */
export function brandStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!isHexColor(color) || contrastRatio(color, "#FFFFFF") < MIN_BRAND_CONTRAST) return undefined;
  return {
    "--primary": color,
    "--primary-foreground": readableTextOn(color),
    "--ring": color,
    "--accent": `color-mix(in oklab, ${color} 9%, white)`,
    "--accent-foreground": color,
  } as CSSProperties;
}
