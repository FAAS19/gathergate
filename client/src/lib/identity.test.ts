import { describe, expect, it } from "vitest";
import { getInitials, operatorDisplayName } from "./identity";

describe("identity helpers", () => {
  it("extracts clean initials without punctuation or connector words", () => {
    expect(getInitials("Spine & Strength Chiropractic")).toBe("SS");
    expect(getInitials("Harbour Advisory")).toBe("HA");
    expect(getInitials("O'Connor & Co Pty Ltd")).toBe("O");
    expect(getInitials("Sarah Mitchell")).toBe("SM");
    expect(getInitials("Ahmed")).toBe("A");
    expect(getInitials("&&&")).toBe("GG");
  });

  it("derives readable operator display names from profile or email", () => {
    expect(operatorDisplayName("Sarah Mitchell", "ops@harbour.test")).toBe("Sarah Mitchell");
    expect(operatorDisplayName(null, "ahmed@spine.com.au")).toBe("Ahmed");
    expect(operatorDisplayName("", "sarah.mitchell@firm.test")).toBe("Sarah Mitchell");
    expect(operatorDisplayName(undefined, undefined)).toBe("Operator");
  });
});
