import type { ValidationResult, ValidatorPack } from "./types.js";

export function validateAuAbn(raw: string): ValidationResult {
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

export function validateAuBsb(raw: string): ValidationResult {
  const digits = raw.replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(digits)) {
    return { valid: false, error: "BSB must be exactly 6 digits (e.g. 062-000)" };
  }
  return { valid: true, normalised: `${digits.slice(0, 3)}-${digits.slice(3, 6)}` };
}

export function validateAuTfn(raw: string): ValidationResult {
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

export function validateAuMedicare(raw: string): ValidationResult {
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

export function validateAuPhone(raw: string): ValidationResult {
  const cleaned = raw.replace(/[\s()-]+/g, "");
  let e164 = "";
  if (/^\+61[23478]\d{8}$/.test(cleaned)) {
    e164 = cleaned;
  } else if (/^61[23478]\d{8}$/.test(cleaned)) {
    e164 = `+${cleaned}`;
  } else if (/^0[23478]\d{8}$/.test(cleaned)) {
    e164 = `+61${cleaned.slice(1)}`;
  } else {
    return { valid: false, error: "Enter a valid Australian mobile or landline number (e.g. 0412 345 678)" };
  }
  return { valid: true, normalised: e164 };
}

export const auPack: ValidatorPack = {
  id: "au",
  name: "Australia",
  validators: {
    au_phone_e164: { label: "AU phone (+61 E.164)", short: "+61 Phone", hint: "0412 345 678", validate: validateAuPhone },
    au_abn_mod89: { label: "ATO ABN (11-digit mod-89)", short: "ABN", hint: "51 824 753 556", validate: validateAuAbn },
    au_bsb: { label: "Australian BSB (6-digit)", short: "BSB", hint: "062-000", validate: validateAuBsb },
    au_tfn_mod11: {
      label: "ATO TFN (mod-11, masked)",
      short: "TFN",
      hint: "8 or 9 digits, stored masked",
      sensitive: true,
      validate: validateAuTfn,
    },
    au_medicare_mod10: {
      label: "Medicare + IRN (mod-10, masked)",
      short: "Medicare",
      hint: "10 or 11 digits incl. IRN",
      sensitive: true,
      validate: validateAuMedicare,
    },
  },
};
