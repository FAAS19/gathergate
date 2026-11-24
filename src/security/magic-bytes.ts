export interface DetectedFileType {
  mime: string;
  ext: string;
}

export const ALLOWED_TYPE_GROUPS: Record<string, string[]> = {
  pdf: ["application/pdf"],
  image: ["image/png", "image/jpeg", "image/webp"],
  spreadsheet: [
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  document: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ],
  any_safe: [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "text/csv",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
};

function startsWithBytes(buf: Buffer, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

function isMostlyPrintableUtf8(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.length === 0) return false;
  // Reject NUL bytes (binary/executable files)
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0x00) return false;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample);
    // Reject obvious HTML/script injection disguised as CSV/TXT
    if (/<\s*(script|html|svg|iframe)\b/i.test(decoded)) return false;
    return true;
  } catch {
    return false;
  }
}

function detectOpenXmlSubType(buf: Buffer): DetectedFileType | null {
  // Inspect ZIP entry names without external parsers to distinguish DOCX vs XLSX
  const ascii = buf.toString("latin1");
  if (ascii.includes("word/document.xml")) {
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: "docx",
    };
  }
  if (ascii.includes("xl/workbook.xml")) {
    return {
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ext: "xlsx",
    };
  }
  return null;
}

export function detectFileSignature(buf: Buffer, originalName: string): DetectedFileType | null {
  if (buf.length === 0) return null;

  // Reject executable headers explicitly (MZ/PE, ELF, Mach-O, shebang)
  if (
    startsWithBytes(buf, [0x4d, 0x5a]) ||
    startsWithBytes(buf, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWithBytes(buf, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWithBytes(buf, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWithBytes(buf, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWithBytes(buf, [0x23, 0x21])
  ) {
    return null;
  }

  // PDF: %PDF-
  if (startsWithBytes(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mime: "application/pdf", ext: "pdf" };
  }

  // PNG
  if (startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }

  // JPEG
  if (startsWithBytes(buf, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    startsWithBytes(buf, [0x52, 0x49, 0x46, 0x46]) &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  // ZIP container -> allow only DOCX / XLSX (block arbitrary ZIP bombs/archives)
  if (startsWithBytes(buf, [0x50, 0x4b, 0x03, 0x04])) {
    return detectOpenXmlSubType(buf);
  }

  // Plain CSV or TXT
  const lower = originalName.toLowerCase();
  if (isMostlyPrintableUtf8(buf)) {
    if (lower.endsWith(".csv")) return { mime: "text/csv", ext: "csv" };
    if (lower.endsWith(".txt")) return { mime: "text/plain", ext: "txt" };
  }

  return null;
}

export function resolveAllowedMimes(allowedGroups: string[] | undefined): string[] {
  if (!allowedGroups || allowedGroups.length === 0) {
    return ALLOWED_TYPE_GROUPS.any_safe;
  }
  const mimes = new Set<string>();
  for (const group of allowedGroups) {
    const resolved = ALLOWED_TYPE_GROUPS[group];
    if (resolved) {
      for (const m of resolved) mimes.add(m);
    } else if (group.includes("/")) {
      mimes.add(group);
    }
  }
  return mimes.size > 0 ? [...mimes] : ALLOWED_TYPE_GROUPS.any_safe;
}
