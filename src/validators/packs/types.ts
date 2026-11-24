export interface ValidationResult {
  valid: boolean;
  normalised?: string;
  error?: string;
}

export interface ValidatorDef {
  label: string;
  short: string;
  hint?: string;
  /** Sensitive values are masked everywhere except an audited operator reveal. */
  sensitive?: boolean;
  /** Receives a trimmed, non-empty value. */
  validate(value: string): ValidationResult;
}

export interface ValidatorPack {
  id: string;
  name: string;
  validators: Record<string, ValidatorDef>;
}
