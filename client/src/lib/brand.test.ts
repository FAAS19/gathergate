import { describe, expect, it } from "vitest";
// Server modules are plain TS with no Node-only imports, so the client can check it stays in sync.
import { readableTextOn as serverReadableTextOn } from "../../../src/emails/templates";
import { listValidators } from "../../../src/validators/index";
import { VALIDATOR_OPTIONS } from "./api";
import { brandStyle, contrastRatio, readableTextOn } from "./brand";

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
});

describe("validator options", () => {
  it("cover every server validator key", () => {
    const server = listValidators().map((v) => v.key).sort();
    const client = VALIDATOR_OPTIONS.map((v) => v.value).sort();
    expect(client).toEqual(server);
  });
});
