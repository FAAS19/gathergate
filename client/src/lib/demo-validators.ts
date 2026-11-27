export interface DemoValidationResult {
  valid: boolean;
  normalised?: string;
  error?: string;
}

interface DemoValidatorDef {
  hint?: string;
  sensitive?: boolean;
  validate(value: string): DemoValidationResult;
}

function validateEmail(v: string): DemoValidationResult {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)
    ? { valid: true, normalised: v.toLowerCase() }
    : { valid: false, error: "Enter a valid email address" };
}

function validateUrl(v: string): DemoValidationResult {
  try {
    const parsed = new URL(v);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { valid: false, error: "URL must start with https:// or http://" };
    }
    return { valid: true, normalised: parsed.toString() };
  } catch {
    return { valid: false, error: "Enter a valid URL (e.g. https://example.com)" };
  }
}

function validatePhoneE164(v: string): DemoValidationResult {
  const cleaned = v.replace(/[\s().-]+/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    return {
      valid: false,
      error: "Enter an international number starting with + and country code (e.g. +44 20 7946 0958)",
    };
  }
  return { valid: true, normalised: cleaned };
}

// ISO 13616 IBAN: move first 4 chars to end, letters to numbers (A=10), mod 97 must equal 1.
function validateIban(v: string): DemoValidationResult {
  const iban = v.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return { valid: false, error: "IBAN must start with a 2-letter country code and 2 check digits" };
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) remainder = (remainder * 10 + Number(d)) % 97;
  }
  if (remainder !== 1) return { valid: false, error: "Invalid IBAN checksum (mod-97 failed)" };
  return { valid: true, normalised: iban.replace(/(.{4})/g, "$1 ").trim() };
}

function validateAuPhone(raw: string): DemoValidationResult {
  const cleaned = raw.replace(/[\s()-]+/g, "");
  let e164 = "";
  if (/^\+61[23478]\d{8}$/.test(cleaned)) {
    e164 = cleaned;
  } else if (/^61[23478]\d{8}$/.test(cleaned)) {
    e164 = `+${cleaned}`;
  } else if (/^0[23478]\d{8}$/.test(cleaned)) {
    e164 = `+61${cleaned.slice(1)}`;
  } else {
    return {
      valid: false,
      error: "Enter a valid Australian mobile or landline number (e.g. 0412 345 678)",
    };
  }
  return { valid: true, normalised: e164 };
}

function validateAuAbn(raw: string): DemoValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^[1-9]\d{10}$/.test(digits)) {
    return { valid: false, error: "ABN must be 11 digits and cannot start with 0" };
  }
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const nums = digits.split("").map((d) => Number(d));
  nums[0] -= 1;
  const sum = nums.reduce((acc, n, i) => acc + n * weights[i], 0);
  if (sum % 89 !== 0) {
    return { valid: false, error: "Invalid ABN checksum (ATO mod-89 failed)" };
  }
  return {
    valid: true,
    normalised: `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 11)}`,
  };
}

function validateAuBsb(raw: string): DemoValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(digits)) {
    return { valid: false, error: "BSB must be exactly 6 digits (e.g. 062-000)" };
  }
  return { valid: true, normalised: `${digits.slice(0, 3)}-${digits.slice(3, 6)}` };
}

function validateAuTfn(raw: string): DemoValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{8,9}$/.test(digits) || /^0+$/.test(digits)) {
    return { valid: false, error: "TFN must be 8 or 9 digits" };
  }
  const weights = digits.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : [10, 7, 8, 4, 6, 3, 5, 1];
  const sum = digits.split("").reduce((acc, ch, i) => acc + Number(ch) * weights[i], 0);
  if (sum % 11 !== 0) {
    return { valid: false, error: "Invalid TFN checksum (ATO mod-11 failed)" };
  }
  const formatted =
    digits.length === 9
      ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)}`
      : `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)}`;
  return { valid: true, normalised: formatted };
}

function validateAuMedicare(raw: string): DemoValidationResult {
  const stripped = raw.trim().replace(/\s*\/\s*(?=\d\s*$)/, "");
  const digits = stripped.replace(/[\s-]+/g, "");
  if (!/^\d{10,11}$/.test(digits)) {
    return { valid: false, error: "Medicare number must be 10 digits (+ optional 1-digit IRN)" };
  }
  if (!/^[2-6]/.test(digits)) {
    return { valid: false, error: "Medicare card number must start with 2, 3, 4, 5, or 6" };
  }
  const weights = [1, 3, 7, 9, 1, 3, 7, 9];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += Number(digits[i]) * weights[i];
  }
  if (sum % 10 !== Number(digits[8])) {
    return { valid: false, error: "Invalid Medicare checksum (Services Australia mod-10 failed)" };
  }
  if (digits[9] === "0") {
    return { valid: false, error: "Medicare issue number (10th digit) cannot be 0" };
  }
  if (digits.length === 11 && digits[10] === "0") {
    return { valid: false, error: "Medicare IRN (11th digit) must be 1 to 9" };
  }
  const base = `${digits.slice(0, 4)} ${digits.slice(4, 9)} ${digits[9]}`;
  return {
    valid: true,
    normalised: digits.length === 11 ? `${base} / ${digits[10]}` : base,
  };
}

function validateUkUtr(raw: string): DemoValidationResult {
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

function validateUkNino(raw: string): DemoValidationResult {
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (!/^(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(cleaned)) {
    return { valid: false, error: "Enter a valid UK National Insurance number (e.g. AA 12 34 56 C)" };
  }
  return {
    valid: true,
    normalised: `${cleaned.slice(0, 2)} ${cleaned.slice(2, 4)} ${cleaned.slice(4, 6)} ${cleaned.slice(6, 8)} ${cleaned[8]}`,
  };
}

function validateUkSortCode(raw: string): DemoValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(digits) || digits === "000000") {
    return { valid: false, error: "UK Sort Code must be 6 digits and not 00-00-00" };
  }
  return { valid: true, normalised: `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}` };
}

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

function validateUsEin(raw: string): DemoValidationResult {
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

function validateUsRoutingAba(raw: string): DemoValidationResult {
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

function validateUsSsn(raw: string): DemoValidationResult {
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

function validateEuVat(raw: string): DemoValidationResult {
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

const VALIDATORS: Record<string, DemoValidatorDef> = {
  none: { validate: (v) => ({ valid: true, normalised: v }) },
  email: { hint: "name@company.com", validate: validateEmail },
  url: { hint: "https://example.com", validate: validateUrl },
  phone_e164: { hint: "+44 20 7946 0958", validate: validatePhoneE164 },
  iban: { hint: "GB82 WEST 1234 5698 7654 32", validate: validateIban },
  au_phone_e164: { hint: "0412 345 678", validate: validateAuPhone },
  au_abn_mod89: { hint: "51 824 753 556", validate: validateAuAbn },
  au_bsb: { hint: "062-000", validate: validateAuBsb },
  au_tfn_mod11: { hint: "8 or 9 digits, stored masked", sensitive: true, validate: validateAuTfn },
  au_medicare_mod10: {
    hint: "10 or 11 digits incl. IRN",
    sensitive: true,
    validate: validateAuMedicare,
  },
  uk_utr_mod11: { hint: "10-digit Unique Taxpayer Reference", validate: validateUkUtr },
  uk_nino: { hint: "AA 12 34 56 C, stored masked", sensitive: true, validate: validateUkNino },
  uk_sort_code: { hint: "20-00-00", validate: validateUkSortCode },
  us_ein: { hint: "12-3456789", validate: validateUsEin },
  us_routing_aba: { hint: "021000021", validate: validateUsRoutingAba },
  us_ssn: { hint: "9 digits, stored masked", sensitive: true, validate: validateUsSsn },
  eu_vat: { hint: "DE123456788 or FR40303265045", validate: validateEuVat },
};

export const SENSITIVE_VALIDATORS = new Set<string>(
  Object.entries(VALIDATORS)
    .filter(([, def]) => def.sensitive)
    .map(([key]) => key)
);

export function isKnownValidator(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, key);
}

export function getValidatorHint(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, key) ? VALIDATORS[key].hint : undefined;
}

export function validateTextValue(validator: string, raw: string): DemoValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false, error: "Value is required" };
  if (!isKnownValidator(validator)) {
    return { valid: false, error: "This field has an unknown validator. Contact the sender." };
  }
  return VALIDATORS[validator].validate(trimmed);
}

export function maskSensitiveValue(validator: string, value: string): string {
  if (!SENSITIVE_VALIDATORS.has(validator)) return value;
  const compact = /[A-Za-z]/.test(value)
    ? value.replace(/[\s-]+/g, "").toUpperCase()
    : value.replace(/\D+/g, "");
  if (compact.length <= 3) return "***";
  const tail = compact.slice(-3);
  return `${"*".repeat(Math.max(3, compact.length - 3))} ${tail}`;
}
