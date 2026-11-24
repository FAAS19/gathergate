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
