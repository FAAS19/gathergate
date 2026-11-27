import type { ValidationResult, ValidatorPack } from "./types.js";

const EU_VAT_PATTERNS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(?:\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/,
  IT: /^\d{11}$/,
  LT: /^(?:\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

function checkDeVat(body: string): boolean {
  let product = 10;
  for (let i = 0; i < 8; i++) {
    let sum = (Number(body[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const checkDigit = (11 - product) % 10;
  return Number(body[8]) === checkDigit;
}

export function validateEuVat(raw: string): ValidationResult {
  const cleaned = raw.replace(/[\s.-]+/g, "").toUpperCase();
  if (cleaned.length < 4) {
    return { valid: false, error: "EU VAT number must start with a 2-letter EU member state code" };
  }
  const country = cleaned.slice(0, 2);
  const body = cleaned.slice(2);
  const pattern = EU_VAT_PATTERNS[country];
  if (!pattern) {
    return { valid: false, error: `Unsupported or non-EU VAT country code "${country}"` };
  }
  if (!pattern.test(body)) {
    return { valid: false, error: `Invalid ${country} VAT format` };
  }
  if (country === "BE") {
    if (97 - (Number(body.slice(0, 8)) % 97) !== Number(body.slice(8, 10))) {
      return { valid: false, error: "Invalid BE VAT checksum (mod-97 failed)" };
    }
  } else if (country === "DE") {
    if (!checkDeVat(body)) {
      return { valid: false, error: "Invalid DE VAT checksum (ISO 7064 mod 11,10 failed)" };
    }
  } else if (country === "FR") {
    const key = body.slice(0, 2);
    const siren = body.slice(2);
    if (/^\d{2}/.test(key) && Number(key) !== (12 + 3 * (Number(siren) % 97)) % 97) {
      return { valid: false, error: "Invalid FR VAT checksum (mod-97 failed)" };
    }
  }
  return { valid: true, normalised: `${country}${body}` };
}

export const euPack: ValidatorPack = {
  id: "eu",
  name: "European Union",
  validators: {
    eu_vat: {
      label: "EU VAT Number (country format + checksum)",
      short: "EU VAT",
      hint: "DE123456788 or FR40303265045",
      validate: validateEuVat,
    },
  },
};
