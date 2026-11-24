import { auPack } from "./packs/au.js";
import { genericPack } from "./packs/generic.js";
import type { ValidationResult, ValidatorDef, ValidatorPack } from "./packs/types.js";

export type { ValidationResult, ValidatorDef, ValidatorPack } from "./packs/types.js";

/** Add a country pack: create `packs/<code>.ts` exporting a ValidatorPack, then list it here. */
export const VALIDATOR_PACKS: ValidatorPack[] = [genericPack, auPack];

/** Validator keys are stored in templates and request items; unknown keys always fail closed. */
export type ValidatorKey = string;

const REGISTRY = new Map<string, ValidatorDef & { pack: string }>();
for (const pack of VALIDATOR_PACKS) {
  for (const [key, def] of Object.entries(pack.validators)) {
    if (REGISTRY.has(key)) throw new Error(`Duplicate validator key "${key}" in pack "${pack.id}"`);
    REGISTRY.set(key, { ...def, pack: pack.id });
  }
}

export const SENSITIVE_VALIDATORS = new Set<string>(
  [...REGISTRY].filter(([, def]) => def.sensitive).map(([key]) => key)
);

export function isKnownValidator(key: string): boolean {
  return REGISTRY.has(key);
}

export function getValidatorHint(key: string): string | undefined {
  return REGISTRY.get(key)?.hint;
}

export function listValidators() {
  return [...REGISTRY].map(([key, def]) => ({
    key,
    pack: def.pack,
    label: def.label,
    short: def.short,
    hint: def.hint ?? null,
    sensitive: Boolean(def.sensitive),
  }));
}

export function validateTextValue(validator: ValidatorKey, raw: string): ValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false, error: "Value is required" };
  const def = REGISTRY.get(validator);
  if (!def) return { valid: false, error: "This field has an unknown validator. Contact the sender." };
  return def.validate(trimmed);
}

export function maskSensitiveValue(validator: ValidatorKey, value: string): string {
  if (!SENSITIVE_VALIDATORS.has(validator)) return value;
  const digits = value.replace(/\D+/g, "");
  if (digits.length <= 3) return "***";
  const tail = digits.slice(-3);
  return `${"*".repeat(Math.max(3, digits.length - 3))} ${tail}`;
}
