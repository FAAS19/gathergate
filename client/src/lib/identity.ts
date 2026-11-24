const STOP_WORDS = new Set([
  "and",
  "of",
  "the",
  "for",
  "pty",
  "ltd",
  "inc",
  "llc",
  "co",
  "group",
]);

/** Extracts clean alphanumeric initials from a practice, person, or client name. */
export function getInitials(value: string | null | undefined, fallback = "GG"): string {
  const cleaned = (value || "")
    .replace(/['’`]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return fallback;

  const tokens = cleaned
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token.toLowerCase()));
  const usable = tokens.length > 0 ? tokens : cleaned.split(/\s+/).filter(Boolean);
  if (usable.length === 0) return fallback;
  if (usable.length === 1) return usable[0].charAt(0).toUpperCase();
  return `${usable[0].charAt(0)}${usable[1].charAt(0)}`.toUpperCase();
}

/** Derives a human-friendly operator name from displayName or email local part. */
export function operatorDisplayName(
  displayName: string | null | undefined,
  email: string | null | undefined
): string {
  const explicit = (displayName || "").trim();
  if (explicit) return explicit;

  const local = (email || "").split("@")[0] || "";
  const parts = local
    .split(/[._+-]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^\d+$/.test(p));
  if (parts.length === 0) return "Operator";
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}
