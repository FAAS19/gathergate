import { describe, expect, it } from "vitest";
// Server modules are plain TS with no Node-only imports, so the client can check it stays in sync.
import { readableTextOn as serverReadableTextOn } from "../../../src/emails/templates";
import { listValidators } from "../../../src/validators/index";
import { VALIDATOR_OPTIONS } from "./api";
import {
  BRAND_PRESETS,
  brandStyle,
  contrastRatio,
  hexToRgb,
  MIN_BRAND_CONTRAST,
  readableTextOn,
  rgbToHex,
} from "./brand";

describe("brand helpers", () => {
  it("match the server email renderer", () => {
    for (const c of ["#0F5243", "#1D4ED8", "#F5D90A", "#FFFFFF", "#000000", "#B45309"]) {
      expect(readableTextOn(c)).toBe(serverReadableTextOn(c));
    }
  });

  it("refuse brand colours too light to read on white", () => {
    expect(brandStyle("#F5D90A")).toBeUndefined();
    expect(brandStyle("not-a-colour")).toBeUndefined();
    expect(brandStyle("#1D4ED8")).toMatchObject({ "--primary": "#1D4ED8", "--primary-foreground": "#FFFFFF" });
    expect(contrastRatio("#1D4ED8", "#FFFFFF")).toBeGreaterThan(3);
  });
  it("converts between HEX and RGB and validates curated presets", () => {
    expect(hexToRgb("#0F5243")).toEqual({ r: 15, g: 82, b: 67 });
    expect(hexToRgb("invalid")).toBeNull();
    expect(rgbToHex(15, 82, 67)).toBe("#0F5243");
    expect(rgbToHex(-10, 300, 12.6)).toBe("#00FF0D");

    for (const preset of BRAND_PRESETS) {
      expect(contrastRatio(preset.hex, "#FFFFFF")).toBeGreaterThanOrEqual(MIN_BRAND_CONTRAST);
      const rgb = hexToRgb(preset.hex)!;
      expect(rgbToHex(rgb.r, rgb.g, rgb.b)).toBe(preset.hex);
    }
  });
});

describe("validator options", () => {
  it("cover every server validator key", () => {
    const server = listValidators().map((v) => v.key).sort();
    const client = VALIDATOR_OPTIONS.map((v) => v.value).sort();
    expect(client).toEqual(server);
  });
});
