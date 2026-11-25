import type { ValidationResult, ValidatorPack } from "./types.js";

export function validateUkUtr(raw: string): ValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{10}$/.test(digits)) {
    return { valid: false, error: "UK UTR must be exactly 10 digits" };
  }
  const weights = [6, 7, 8, 9, 10, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(digits[i + 1]) * weights[i];
  }
  const expected = [2, 1, 9, 8, 7, 6, 5, 4, 3, 2, 1][sum % 11];
  if (Number(digits[0]) !== expected) {
    return { valid: false, error: "Invalid UK UTR checksum (HMRC mod-11 failed)" };
  }
  return { valid: true, normalised: `${digits.slice(0, 5)} ${digits.slice(5, 10)}` };
}

export function validateUkNino(raw: string): ValidationResult {
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (!/^(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(cleaned)) {
    return { valid: false, error: "Enter a valid UK National Insurance number (e.g. AA 12 34 56 C)" };
  }
  return {
    valid: true,
    normalised: `${cleaned.slice(0, 2)} ${cleaned.slice(2, 4)} ${cleaned.slice(4, 6)} ${cleaned.slice(6, 8)} ${cleaned[8]}`,
  };
}

export function validateUkSortCode(raw: string): ValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(digits) || digits === "000000") {
    return { valid: false, error: "UK Sort Code must be 6 digits and not 00-00-00" };
  }
  return { valid: true, normalised: `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}` };
}

export const ukPack: ValidatorPack = {
  id: "uk",
  name: "United Kingdom",
  validators: {
    uk_utr_mod11: {
      label: "HMRC UTR (10-digit mod-11)",
      short: "UK UTR",
      hint: "10-digit Unique Taxpayer Reference",
      validate: validateUkUtr,
    },
    uk_nino: {
      label: "UK National Insurance (masked)",
      short: "UK NINO",
      hint: "AA 12 34 56 C, stored masked",
      sensitive: true,
      validate: validateUkNino,
    },
    uk_sort_code: {
      label: "UK Bank Sort Code (6-digit)",
      short: "Sort Code",
      hint: "20-00-00",
      validate: validateUkSortCode,
    },
  },
};
