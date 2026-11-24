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
  if (!/^\d{11}$/.test(digits)) {
    return { valid: false, error: "ABN must be exactly 11 digits" };
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
  if (!/^\d{8,9}$/.test(digits)) {
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
  const digits = raw.replace(/[\s-]+/g, "");
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
  const digits = value.replace(/\D+/g, "");
  if (digits.length <= 3) return "***";
  const tail = digits.slice(-3);
  return `${"*".repeat(Math.max(3, digits.length - 3))} ${tail}`;
}
