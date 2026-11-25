import type { ValidationResult, ValidatorPack } from "./types.js";

function isValidEinPrefix(prefix: number): boolean {
  return (
    (prefix >= 1 && prefix <= 6) ||
    (prefix >= 10 && prefix <= 16) ||
    (prefix >= 20 && prefix <= 27) ||
    (prefix >= 30 && prefix <= 48) ||
    (prefix >= 50 && prefix <= 68) ||
    (prefix >= 71 && prefix <= 77) ||
    (prefix >= 80 && prefix <= 88) ||
    (prefix >= 90 && prefix <= 95) ||
    (prefix >= 98 && prefix <= 99)
  );
}

export function validateUsEin(raw: string): ValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{9}$/.test(digits)) {
    return { valid: false, error: "IRS EIN must be exactly 9 digits (XX-XXXXXXX)" };
  }
  const prefix = Number(digits.slice(0, 2));
  if (!isValidEinPrefix(prefix)) {
    return { valid: false, error: "Invalid IRS EIN prefix" };
  }
  return { valid: true, normalised: `${digits.slice(0, 2)}-${digits.slice(2, 9)}` };
}

function isValidAbaPrefix(prefix: number): boolean {
  return (
    (prefix >= 0 && prefix <= 12) ||
    (prefix >= 21 && prefix <= 32) ||
    (prefix >= 61 && prefix <= 72) ||
    prefix === 80
  );
}

export function validateUsRoutingAba(raw: string): ValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{9}$/.test(digits)) {
    return { valid: false, error: "ABA routing number must be exactly 9 digits" };
  }
  const prefix = Number(digits.slice(0, 2));
  if (!isValidAbaPrefix(prefix)) {
    return { valid: false, error: "Invalid ABA routing number Federal Reserve prefix" };
  }
  const d = digits.split("").map(Number);
  const checksum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  if (checksum % 10 !== 0) {
    return { valid: false, error: "Invalid ABA routing number checksum (mod-10 failed)" };
  }
  return { valid: true, normalised: digits };
}

export function validateUsSsn(raw: string): ValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{9}$/.test(digits)) {
    return { valid: false, error: "US SSN must be exactly 9 digits" };
  }
  const area = Number(digits.slice(0, 3));
  const group = digits.slice(3, 5);
  const serial = digits.slice(5, 9);
  if (area === 0 || area === 666 || area >= 900 || group === "00" || serial === "0000") {
    return { valid: false, error: "Invalid US SSN (violates SSA area, group, or serial rules)" };
  }
  return { valid: true, normalised: `${digits.slice(0, 3)}-${group}-${serial}` };
}

export const usPack: ValidatorPack = {
  id: "us",
  name: "United States",
  validators: {
    us_ein: {
      label: "IRS EIN (9-digit XX-XXXXXXX)",
      short: "US EIN",
      hint: "12-3456789",
      validate: validateUsEin,
    },
    us_routing_aba: {
      label: "US ABA Routing Number (mod-10)",
      short: "ABA Routing",
      hint: "021000021",
      validate: validateUsRoutingAba,
    },
    us_ssn: {
      label: "US SSN (SSA rules, masked)",
      short: "US SSN",
      hint: "9 digits, stored masked",
      sensitive: true,
      validate: validateUsSsn,
    },
  },
};
