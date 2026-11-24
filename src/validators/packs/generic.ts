import type { ValidatorPack } from "./types.js";

function validateEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)
    ? { valid: true, normalised: v.toLowerCase() }
    : { valid: false, error: "Enter a valid email address" };
}

function validateUrl(v: string) {
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

function validatePhoneE164(v: string) {
  const cleaned = v.replace(/[\s().-]+/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    return { valid: false, error: "Enter an international number starting with + and country code (e.g. +44 20 7946 0958)" };
  }
  return { valid: true, normalised: cleaned };
}

// ISO 13616 IBAN: move first 4 chars to end, letters to numbers (A=10), mod 97 must equal 1.
function validateIban(v: string) {
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

export const genericPack: ValidatorPack = {
  id: "generic",
  name: "Generic",
  validators: {
    none: { label: "None (any text)", short: "Text", validate: (v) => ({ valid: true, normalised: v }) },
    email: { label: "Email address", short: "Email", hint: "name@company.com", validate: validateEmail },
    url: { label: "Website URL (https://)", short: "URL", hint: "https://example.com", validate: validateUrl },
    phone_e164: {
      label: "International phone (E.164)",
      short: "Phone",
      hint: "+44 20 7946 0958",
      validate: validatePhoneE164,
    },
    iban: { label: "IBAN (mod-97)", short: "IBAN", hint: "GB82 WEST 1234 5698 7654 32", validate: validateIban },
  },
};
