import {
  ApiError,
  VALIDATOR_OPTIONS,
  type ApiKeyDto,
  type ApiKeyScope,
  type AuditEventDto,
  type BrandingDto,
  type ClientPortalResponse,
  type ClientRequestBriefDto,
  type ClientSummaryDto,
  type EmailSettingsDto,
  type ItemKind,
  type OutboxEmailDto,
  type RequestDetailResponse,
  type RequestItemDto,
  type RequestsListResponse,
  type RequestSummaryDto,
  type SessionResponse,
  type SettingsResponse,
  type TemplateDto,
  type TemplateItemSpec,
  type UploadDto,
  type WebhookDeliveryDto,
  type WorkspaceDto,
} from "./api";
import {
  getValidatorHint,
  isKnownValidator,
  maskSensitiveValue,
  SENSITIVE_VALIDATORS,
  validateTextValue,
} from "./demo-validators";

const DEMO_OTP_CODE = "482910";
const MANUAL_COOLDOWN_MS = 15 * 60_000;
const MAX_LOGO_BYTES = 200 * 1024;
const MAX_CLIENT_NOTE_CHARS = 1000;
const MAX_TEXT_ITEM_CHARS = 2000;
const MAX_TEXTAREA_ITEM_CHARS = 20_000;
const MAX_FILES_PER_UPLOAD = 10;
const MAX_ITEM_FILE_MB = 50;
const MAX_DEMO_STORAGE_BYTES = 50 * 1024 * 1024;
const SAFE_LOGO_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

interface DemoItemRecord {
  id: string;
  position: number;
  section: string;
  label: string;
  help_text: string;
  kind: ItemKind;
  required: boolean;
  validator: string;
  config: {
    allowedGroups?: string[];
    maxFileMb?: number;
    multiple?: boolean;
    slug?: string;
  };
  status: "pending" | "submitted" | "rejected" | "approved";
  rawValue: string | null;
  review_note: string | null;
  client_note: string | null;
  client_na: boolean;
  updated_at: string;
  uploads: UploadDto[];
}

interface DemoRequestRecord {
  id: string;
  magicToken: string;
  title: string;
  client_name: string;
  client_email: string;
  client_subject: string | null;
  welcome_note: string | null;
  status: "open" | "in_review" | "completed" | "expired" | "purged";
  require_otp: boolean;
  reminder_interval_days: number;
  max_reminders: number;
  reminders_sent: number;
  reminders_paused: boolean;
  next_reminder_at: string | null;
  purge_after_days: number;
  purge_at: string | null;
  due_at: string | null;
  last_opened_at: string | null;
  last_manual_reminder_at: string | null;
  completed_at: string | null;
  is_demo: boolean;
  created_at: string;
  items: DemoItemRecord[];
  auditEvents: AuditEventDto[];
}

interface DemoState {
  seq: number;
  loggedIn: boolean;
  user: { id: string; email: string; displayName: string };
  workspace: WorkspaceDto;
  logoDataUrl: string | null;
  webhookSecret: string;
  email: EmailSettingsDto;
  templates: TemplateDto[];
  requests: DemoRequestRecord[];
  outbox: OutboxEmailDto[];
  apiKeys: ApiKeyDto[];
  webhookDeliveries: WebhookDeliveryDto[];
  blobs: Map<string, Blob>;
  otpVerifiedRequestIds: Set<string>;
}

const BUILTIN_TEMPLATE_SPECS: Array<{
  id: string;
  name: string;
  description: string;
  items: TemplateItemSpec[];
}> = [
  {
    id: "tpl_agency",
    name: "Agency / Web Project Client Onboarding",
    description:
      "Collect brand assets, hosting/domain contacts, company details, and scope sign-off without endless email threads.",
    items: [
      {
        section: "Company Details",
        label: "Primary Project Contact Email",
        helpText: "Email address for approvals and handover credentials.",
        kind: "text",
        required: true,
        validator: "email",
        slug: "contact-email",
      },
      {
        section: "Company Details",
        label: "Existing Website URL",
        helpText: "Include https:// (or enter https://example.com if greenfield).",
        kind: "text",
        required: false,
        validator: "url",
        slug: "website-url",
      },
      {
        section: "Brand & Creative Assets",
        label: "High-Resolution Brand Logo & Style Guide",
        helpText: "Upload PNG/JPEG/PDF brand files (max 20 MB each).",
        kind: "file",
        required: true,
        validator: "none",
        allowedGroups: ["pdf", "image"],
        maxFileMb: 20,
        multiple: true,
        slug: "brand-assets",
      },
      {
        section: "Brand & Creative Assets",
        label: "Copywriting & Key Page Notes",
        helpText: "Key messaging points, offers, or links to existing drafts.",
        kind: "textarea",
        required: false,
        validator: "none",
        slug: "copy-notes",
      },
      {
        section: "Sign-Off",
        label: "Authorisation Declaration",
        helpText: "I confirm we hold rights to all uploaded assets and approve kick-off.",
        kind: "checkbox",
        required: true,
        validator: "none",
        slug: "authorisation",
      },
    ],
  },
  {
    id: "tpl_tax",
    name: "AU Individual Tax Return (EOFY Pack)",
    description:
      "Australian EOFY personal tax checklist with ATO TFN mod-11 masking, BSB verification, and receipt uploads.",
    items: [
      {
        section: "Identity & ATO Details",
        label: "Tax File Number (TFN)",
        helpText: "Validated deterministically via ATO mod-11 and stored encrypted/masked.",
        kind: "text",
        required: true,
        validator: "au_tfn_mod11",
        slug: "tfn",
      },
      {
        section: "Identity & ATO Details",
        label: "Refund Bank BSB",
        helpText: "6-digit Australian BSB (e.g. 062-000).",
        kind: "text",
        required: true,
        validator: "au_bsb",
        slug: "refund-bsb",
      },
      {
        section: "Identity & ATO Details",
        label: "Mobile Phone Number",
        helpText: "Australian mobile normalised to +61 E.164.",
        kind: "text",
        required: true,
        validator: "au_phone_e164",
        slug: "mobile",
      },
      {
        section: "Income & Deductions",
        label: "Private Health Insurance Tax Statement",
        helpText: "Annual PDF statement from your health fund.",
        kind: "file",
        required: false,
        validator: "none",
        allowedGroups: ["pdf", "image"],
        maxFileMb: 15,
        multiple: false,
        slug: "private-health-statement",
      },
      {
        section: "Income & Deductions",
        label: "Work-Related Expense Receipts & Logbook",
        helpText: "Upload PDFs, images, or CSV/XLSX summary spreadsheets.",
        kind: "file",
        required: true,
        validator: "none",
        allowedGroups: ["pdf", "image", "spreadsheet"],
        maxFileMb: 25,
        multiple: true,
        slug: "deduction-receipts",
      },
      {
        section: "Declaration",
        label: "Taxpayer Accuracy Declaration",
        helpText: "I declare all income and deduction records provided are true and complete.",
        kind: "checkbox",
        required: true,
        validator: "none",
        slug: "tax-declaration",
      },
    ],
  },
  {
    id: "tpl_bas",
    name: "AU Company / BAS Bookkeeping Pack",
    description:
      "Quarterly BAS & supplier invoice intake pack with ATO ABN mod-89 validation and bank/statement uploads.",
    items: [
      {
        section: "Entity Identification",
        label: "Australian Business Number (ABN)",
        helpText: "11-digit ABN verified via ATO modulo-89 maths.",
        kind: "text",
        required: true,
        validator: "au_abn_mod89",
        slug: "abn",
      },
      {
        section: "Entity Identification",
        label: "Operating Bank BSB",
        helpText: "6-digit BSB for reconciliation verification.",
        kind: "text",
        required: true,
        validator: "au_bsb",
        slug: "bank-bsb",
      },
      {
        section: "Quarter Records",
        label: "Business Bank Statements (Full Quarter)",
        helpText: "Upload official PDF statements or CSV exports.",
        kind: "file",
        required: true,
        validator: "none",
        allowedGroups: ["pdf", "spreadsheet"],
        maxFileMb: 25,
        multiple: true,
        slug: "bank-statements",
      },
      {
        section: "Quarter Records",
        label: "Missing Supplier Tax Invoices & Capital Purchases",
        helpText: "PDF or photo scans of tax invoices over $82.50 incl. GST.",
        kind: "file",
        required: false,
        validator: "none",
        allowedGroups: ["pdf", "image"],
        maxFileMb: 20,
        multiple: true,
        slug: "supplier-invoices",
      },
      {
        section: "Sign-Off",
        label: "Director BAS Lodgement Authority",
        helpText: "I confirm records cover the complete BAS reporting period.",
        kind: "checkbox",
        required: true,
        validator: "none",
        slug: "bas-authority",
      },
    ],
  },
  {
    id: "tpl_health",
    name: "AU Allied Health Clinic New Patient Intake",
    description:
      "Passwordless clinical referral & Medicare intake pack with Services Australia mod-10 + IRN verification.",
    items: [
      {
        section: "Patient Details",
        label: "Medicare Card Number + IRN",
        helpText:
          "11 digits including 1-digit IRN (verified via Services Australia mod-10 and stored masked).",
        kind: "text",
        required: true,
        validator: "au_medicare_mod10",
        slug: "medicare",
      },
      {
        section: "Patient Details",
        label: "Patient Mobile Number",
        helpText: "Used for appointment SMS confirmations (+61).",
        kind: "text",
        required: true,
        validator: "au_phone_e164",
        slug: "patient-mobile",
      },
      {
        section: "Clinical Documents",
        label: "GP Referral / Care Plan (EPC / MHCP)",
        helpText: "Upload PDF or clear photo of signed GP referral letter.",
        kind: "file",
        required: true,
        validator: "none",
        allowedGroups: ["pdf", "image"],
        maxFileMb: 15,
        multiple: true,
        slug: "gp-referral",
      },
      {
        section: "Consent",
        label: "Privacy & Clinical Intake Consent",
        helpText:
          "I consent to the clinic collecting these records for treatment and Medicare claiming.",
        kind: "checkbox",
        required: true,
        validator: "none",
        slug: "clinical-consent",
      },
    ],
  },
  {
    id: "tpl_kyc",
    name: "Legal / KYC Client Onboarding",
    description:
      "Know-your-client intake pack with verified E.164 phone, IBAN banking, photo ID upload, and compliance sign-off.",
    items: [
      {
        section: "Contact & Identity",
        label: "Authorised Signatory Email",
        helpText: "Email address for engagement letters and compliance notices.",
        kind: "text",
        required: true,
        validator: "email",
        slug: "signatory-email",
      },
      {
        section: "Contact & Identity",
        label: "Primary Mobile or Direct Phone",
        helpText: "International format starting with + and country code.",
        kind: "text",
        required: true,
        validator: "phone_e164",
        slug: "primary-phone",
      },
      {
        section: "Banking & AML",
        label: "Settlement IBAN",
        helpText: "International Bank Account Number verified via mod-97.",
        kind: "text",
        required: true,
        validator: "iban",
        slug: "settlement-iban",
      },
      {
        section: "Verification Documents",
        label: "Certified Photo ID (Passport or Driver Licence)",
        helpText: "Upload clear PDF or image scans of current government-issued ID.",
        kind: "file",
        required: true,
        validator: "none",
        allowedGroups: ["pdf", "image"],
        maxFileMb: 15,
        multiple: true,
        slug: "photo-id",
      },
      {
        section: "Declaration",
        label: "KYC & AML Confirmation",
        helpText:
          "I confirm all identity and banking details provided are accurate and belong to the named client.",
        kind: "checkbox",
        required: true,
        validator: "none",
        slug: "kyc-confirmation",
      },
    ],
  },
  {
    id: "tpl_mortgage",
    name: "Mortgage & Loan Document Pack",
    description:
      "Borrowing assessment pack with contact email, optional US ABA routing verification, bank statement and payslip uploads, and borrower declaration.",
    items: [
      {
        section: "Borrower Details",
        label: "Borrower Email Address",
        helpText: "Primary email for lending updates and settlement notices.",
        kind: "text",
        required: true,
        validator: "email",
        slug: "borrower-email",
      },
      {
        section: "Borrower Details",
        label: "US Servicing Bank ABA Routing Number",
        helpText: "Optional 9-digit US ABA routing number for direct debit verification.",
        kind: "text",
        required: false,
        validator: "us_routing_aba",
        slug: "aba-routing",
      },
      {
        section: "Financial Records",
        label: "Recent Bank Statements (3 Months)",
        helpText: "Official PDF statements showing income deposits and regular expenses.",
        kind: "file",
        required: true,
        validator: "none",
        allowedGroups: ["pdf"],
        maxFileMb: 25,
        multiple: true,
        slug: "bank-statements",
      },
      {
        section: "Financial Records",
        label: "Recent Payslips or Income Verification",
        helpText: "Upload your last two payslips or latest tax assessment PDFs.",
        kind: "file",
        required: true,
        validator: "none",
        allowedGroups: ["pdf"],
        maxFileMb: 20,
        multiple: true,
        slug: "payslips",
      },
      {
        section: "Declaration",
        label: "Borrower Accuracy Declaration",
        helpText: "I declare all financial statements and income documents supplied are true and unaltered.",
        kind: "checkbox",
        required: true,
        validator: "none",
        slug: "loan-declaration",
      },
    ],
  },
];

const ALLOWED_TYPE_GROUPS: Record<string, string[]> = {
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

function slugify(input: string, fallback = "item"): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

function addDaysIso(fromIso: string, days: number): string {
  const d = new Date(fromIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function portalHref(token: string): string {
  return `./#/c/${token}`;
}

function outboxPortalUrl(token: string): string {
  if (typeof window !== "undefined" && /^https?:/.test(window.location.href)) {
    return new URL(`./#/c/${token}`, window.location.href).href;
  }
  return portalHref(token);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapePdfText(input: string): string {
  return input
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function createSamplePdfBlob(title: string, lines: string[]): Blob {
  const enc = new TextEncoder();
  const ops: string[] = [
    "BT",
    "/F1 16 Tf",
    "54 736 Td",
    `(${escapePdfText(title)}) Tj`,
    "/F1 10 Tf",
    "0 -22 Td",
    "(GatherGate Interactive Demo Document Fixture) Tj",
    "0 -24 Td",
    "/F1 11 Tf",
  ];
  for (const line of lines) {
    ops.push(`(${escapePdfText(line)}) Tj`);
    ops.push("0 -18 Td");
  }
  ops.push("ET");

  const streamBody = ops.join("\n");
  const streamBytes = enc.encode(streamBody).byteLength;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${streamBytes} >>\nstream\n${streamBody}\nendstream\nendobj\n`,
  ];

  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let byteOffset = enc.encode(chunks[0]).byteLength;

  for (const obj of objects) {
    offsets.push(byteOffset);
    chunks.push(obj);
    byteOffset += enc.encode(obj).byteLength;
  }

  const xrefStart = byteOffset;
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (let i = 1; i <= objects.length; i++) {
    chunks.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  );

  return new Blob([enc.encode(chunks.join(""))], { type: "application/pdf" });
}

function createCsvBlob(lines: string[]): Blob {
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  return new Blob([bytes], { type: "text/csv" });
}

function syntheticSha256(seed: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  const part = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${part(h1)}${part(h2)}${part(h1 ^ h2)}${part(h1 + h2)}`.repeat(2);
}

function startsWithBytes(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

function isMostlyPrintableUtf8(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length === 0) return false;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0x00) return false;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample);
    if (/<\s*(script|html|svg|iframe|object|embed)\b|<!doctype\s+html/i.test(decoded)) return false;
    return true;
  } catch {
    return false;
  }
}

function detectFileBytes(bytes: Uint8Array, originalName: string): { mime: string; ext: string } | null {
  if (bytes.length === 0) return null;
  if (
    startsWithBytes(bytes, [0x4d, 0x5a]) ||
    startsWithBytes(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWithBytes(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWithBytes(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWithBytes(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWithBytes(bytes, [0x23, 0x21])
  ) {
    return null;
  }
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mime: "application/pdf", ext: "pdf" };
  }
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    bytes.length >= 12 &&
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const dec = new TextDecoder("latin1");
    const head = dec.decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const tail =
      bytes.length > 65536 ? dec.decode(bytes.subarray(bytes.length - 65536)) : "";
    const sample = head + tail;
    if (sample.includes("word/document.xml")) {
      return {
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ext: "docx",
      };
    }
    if (sample.includes("xl/workbook.xml")) {
      return {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ext: "xlsx",
      };
    }
    return null;
  }
  const lower = originalName.toLowerCase();
  if (isMostlyPrintableUtf8(bytes)) {
    if (lower.endsWith(".csv")) return { mime: "text/csv", ext: "csv" };
    if (lower.endsWith(".txt")) return { mime: "text/plain", ext: "txt" };
  }
  return null;
}

function resolveAllowedMimes(allowedGroups?: string[]): string[] {
  if (!allowedGroups || allowedGroups.length === 0) return ALLOWED_TYPE_GROUPS.any_safe;
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

function renderEmailHtml(params: {
  brandName: string;
  accentColor: string;
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
}): string {
  const accent = /^#[0-9a-fA-F]{6}$/.test(params.accentColor) ? params.accentColor : "#0F5243";
  const ctaHtml = params.cta
    ? `<p style="margin:24px 0 8px;"><a href="${escapeHtml(params.cta.url)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:${accent};color:#ffffff;font-weight:600;text-decoration:none;">${escapeHtml(params.cta.label)}</a></p>`
    : "";
  return `<!doctype html><html lang="en-AU"><body style="margin:0;padding:24px;background:#F8F9F7;font-family:system-ui,-apple-system,sans-serif;color:#11181C;"><div style="max-width:540px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E7E3;border-radius:12px;padding:28px;"><p style="margin:0 0 12px;font-size:13px;font-weight:600;color:${accent};">${escapeHtml(params.brandName)}</p><h1 style="margin:0 0 14px;font-size:19px;">${escapeHtml(params.heading)}</h1>${params.bodyHtml}${ctaHtml}</div></body></html>`;
}

function makeSeedRequestsAndOutbox(nowMs: number, templates: TemplateDto[], blobs: Map<string, Blob>): {
  requests: DemoRequestRecord[];
  outbox: OutboxEmailDto[];
} {
  const nowIso = new Date(nowMs).toISOString();
  const tplTax = templates.find((t) => t.id === "tpl_tax") ?? templates[0];
  const tplBas = templates.find((t) => t.id === "tpl_bas") ?? templates[0];
  const tplHealth = templates.find((t) => t.id === "tpl_health") ?? templates[0];

  const makeItems = (reqId: string, specs: TemplateItemSpec[], ts: string): DemoItemRecord[] =>
    specs.map((spec, idx) => ({
      id: `${reqId}_itm_${idx + 1}`,
      position: idx,
      section: spec.section || "General",
      label: spec.label,
      help_text: spec.helpText || "",
      kind: spec.kind,
      required: Boolean(spec.required),
      validator: spec.validator || "none",
      config: {
        allowedGroups: spec.allowedGroups,
        maxFileMb: spec.maxFileMb ?? 20,
        multiple: Boolean(spec.multiple),
        slug: spec.slug || slugify(spec.label, `item-${idx + 1}`),
      },
      status: "pending",
      rawValue: null,
      review_note: null,
      client_note: null,
      client_na: false,
      updated_at: ts,
      uploads: [],
    }));

  // 1. Claire Nguyen (req_demo_tax, token "demo-tax")
  const r1Created = new Date(nowMs - 14 * 3600_000).toISOString();
  const r1Items = makeItems("req_demo_tax", tplTax.items, r1Created);

  const r1Tfn = r1Items.find((i) => i.validator === "au_tfn_mod11");
  if (r1Tfn) {
    r1Tfn.rawValue = "876 543 210";
    r1Tfn.status = "approved";
  }
  const r1Bsb = r1Items.find((i) => i.validator === "au_bsb");
  if (r1Bsb) {
    r1Bsb.rawValue = "062-000";
    r1Bsb.status = "approved";
  }
  const r1Phone = r1Items.find((i) => i.validator === "au_phone_e164");
  if (r1Phone) {
    r1Phone.rawValue = "+61412345678";
    r1Phone.status = "submitted";
  }
  const r1Health = r1Items.find((i) => i.config.slug === "private-health-statement");
  if (r1Health) {
    const pdfBlob = createSamplePdfBlob("Private Health Insurance Statement (Page 1 of 2)", [
      "Member: Claire Nguyen",
      "Policy Tier: Gold Hospital",
      "Note: Rebate summary table appears on page 2 (omitted in scan).",
    ]);
    const uplId = "upl_demo_tax_health";
    blobs.set(uplId, pdfBlob);
    r1Health.uploads.push({
      id: uplId,
      original_name: "Bupa-Tax-Statement-Page1.pdf",
      canonical_name: "claire-nguyen_private-health-statement_01.pdf",
      detected_mime: "application/pdf",
      size_bytes: pdfBlob.size,
      sha256: syntheticSha256(uplId),
      created_at: r1Created,
    });
    r1Health.status = "rejected";
    r1Health.review_note = "Uploaded page 1 only. Please include the rebate summary on page 2.";
  }
  const r1Receipts = r1Items.find((i) => i.config.slug === "deduction-receipts");
  if (r1Receipts) {
    const csvBlob = createCsvBlob([
      "Date,Category,Supplier,Description,Amount_AUD,GST_AUD",
      "2025-09-14,Professional Membership,CPA Australia,FY26 Annual Membership Renewal,790.00,71.82",
      "2025-11-03,Equipment & Hardware,Officeworks,14-inch Laptop Work Allocation (65%),1420.00,129.09",
      "2026-03-19,Home Office Logbook,ATO Fixed Rate,1140 hours @ $0.67/hr,763.80,0.00",
      "2026-05-22,Reference & Training,Tax Institute,EOFY CPD Webinar Series,285.00,25.91",
    ]);
    const uplId = "upl_demo_tax_receipts";
    blobs.set(uplId, csvBlob);
    r1Receipts.uploads.push({
      id: uplId,
      original_name: "FY26-Work-Deductions-Summary.csv",
      canonical_name: "claire-nguyen_deduction-receipts_01.csv",
      detected_mime: "text/csv",
      size_bytes: csvBlob.size,
      sha256: syntheticSha256(uplId),
      created_at: r1Created,
    });
    r1Receipts.status = "submitted";
  }
  const r1Decl = r1Items.find((i) => i.kind === "checkbox");
  if (r1Decl) {
    r1Decl.rawValue = "confirmed";
    r1Decl.status = "approved";
  }

  const reqTax: DemoRequestRecord = {
    id: "req_demo_tax",
    magicToken: "demo-tax",
    title: "FY26 Individual Tax Return Pack",
    client_name: "Claire Nguyen",
    client_email: "claire.nguyen@example.com.au",
    client_subject: "Documents for your FY26 tax return",
    welcome_note: "Please upload your receipts and confirm your bank BSB before Friday.",
    status: "open",
    require_otp: true,
    reminder_interval_days: 3,
    max_reminders: 4,
    reminders_sent: 0,
    reminders_paused: false,
    next_reminder_at: addDaysIso(nowIso, 3),
    purge_after_days: 14,
    purge_at: null,
    due_at: addDaysIso(nowIso, 5),
    last_opened_at: new Date(nowMs - 2 * 3600_000).toISOString(),
    last_manual_reminder_at: null,
    completed_at: null,
    is_demo: true,
    created_at: r1Created,
    items: r1Items,
    auditEvents: [
      {
        id: "aud_demo_tax_3",
        actor: "operator",
        action: "item.rejected",
        meta_json: JSON.stringify({
          itemId: r1Health?.id,
          note: "Uploaded page 1 only. Please include the rebate summary on page 2.",
        }),
        created_at: new Date(nowMs - 90 * 60_000).toISOString(),
      },
      {
        id: "aud_demo_tax_2",
        actor: "system",
        action: "invite.sent",
        meta_json: JSON.stringify({ to: "claire.nguyen@example.com.au" }),
        created_at: r1Created,
      },
      {
        id: "aud_demo_tax_1",
        actor: "operator",
        action: "request.created",
        meta_json: JSON.stringify({
          clientEmail: "claire.nguyen@example.com.au",
          itemCount: r1Items.length,
          requireOtp: true,
          isDemo: true,
        }),
        created_at: r1Created,
      },
    ],
  };

  // 2. Harbourline Plumbing Pty Ltd (req_demo_bas, token "demo-bas")
  const r2Created = new Date(nowMs - 36 * 3600_000).toISOString();
  const r2Items = makeItems("req_demo_bas", tplBas.items, r2Created);

  const r2Bsb = r2Items.find((i) => i.validator === "au_bsb");
  if (r2Bsb) {
    r2Bsb.rawValue = "083-170";
    r2Bsb.status = "submitted";
  }
  const r2Stmts = r2Items.find((i) => i.config.slug === "bank-statements");
  if (r2Stmts) {
    const csvBlob = createCsvBlob([
      "Date,Account,Description,Debit_AUD,Credit_AUD,Balance_AUD",
      "2026-01-05,NAB Business 083-170,Opening Balance,,,48210.45",
      "2026-01-18,NAB Business 083-170,Southern Cross Pipe & Fittings Inv #88412,4180.00,,44030.45",
      "2026-02-09,NAB Business 083-170,Bayside Strata Progress Claim #3,,18920.00,62950.45",
      "2026-03-14,NAB Business 083-170,Portside Trade Wholesale Inv #4092,3890.35,,59060.10",
      "2026-03-31,NAB Business 083-170,Commercial Fitout Settlement,,3880.00,62940.10",
    ]);
    const uplId = "upl_demo_bas_bank";
    blobs.set(uplId, csvBlob);
    r2Stmts.uploads.push({
      id: uplId,
      original_name: "NAB-Business-Q3-Statement.csv",
      canonical_name: "harbourline-plumbing-pty-ltd_bank-statements_01.csv",
      detected_mime: "text/csv",
      size_bytes: csvBlob.size,
      sha256: syntheticSha256(uplId),
      created_at: r2Created,
    });
    r2Stmts.status = "submitted";
  }

  const reqBas: DemoRequestRecord = {
    id: "req_demo_bas",
    magicToken: "demo-bas",
    title: "Q3 BAS & Supplier Pack",
    client_name: "Harbourline Plumbing Pty Ltd",
    client_email: "accounts@harbourline.example.com.au",
    client_subject: "Q3 BAS records due in 2 days",
    welcome_note: null,
    status: "open",
    require_otp: false,
    reminder_interval_days: 3,
    max_reminders: 4,
    reminders_sent: 1,
    reminders_paused: false,
    next_reminder_at: addDaysIso(nowIso, 2),
    purge_after_days: 30,
    purge_at: null,
    due_at: addDaysIso(nowIso, 2),
    last_opened_at: new Date(nowMs - 26 * 3600_000).toISOString(),
    last_manual_reminder_at: null,
    completed_at: null,
    is_demo: true,
    created_at: r2Created,
    items: r2Items,
    auditEvents: [
      {
        id: "aud_demo_bas_2",
        actor: "system",
        action: "reminder.sent",
        meta_json: JSON.stringify({ reminderNumber: 1, maxReminders: 4 }),
        created_at: new Date(nowMs - 20 * 3600_000).toISOString(),
      },
      {
        id: "aud_demo_bas_1",
        actor: "operator",
        action: "request.created",
        meta_json: JSON.stringify({
          clientEmail: "accounts@harbourline.example.com.au",
          itemCount: r2Items.length,
          requireOtp: false,
          isDemo: true,
        }),
        created_at: r2Created,
      },
    ],
  };

  // 3. Marcus Okafor (req_demo_health, token "demo-health")
  const r3Created = new Date(nowMs - 72 * 3600_000).toISOString();
  const r3Completed = new Date(nowMs - 24 * 3600_000).toISOString();
  const r3Items = makeItems("req_demo_health", tplHealth.items, r3Created);

  const r3Med = r3Items.find((i) => i.validator === "au_medicare_mod10");
  if (r3Med) {
    r3Med.rawValue = "2123 45670 1 / 1";
    r3Med.status = "approved";
  }
  const r3Phone = r3Items.find((i) => i.validator === "au_phone_e164");
  if (r3Phone) {
    r3Phone.rawValue = "+61438901244";
    r3Phone.status = "approved";
  }
  const r3Ref = r3Items.find((i) => i.kind === "file");
  if (r3Ref) {
    const pdfBlob = createSamplePdfBlob("GP Chronic Disease Management Referral (EPC)", [
      "Patient: Marcus Okafor",
      "Medicare Card: 2123 45670 1 / 1",
      "Referring GP: Dr. Priya Sharma (Provider 2426621B)",
      "Approved Sessions: 5 Allied Health Visits",
    ]);
    const uplId = "upl_demo_health_ref";
    blobs.set(uplId, pdfBlob);
    r3Ref.uploads.push({
      id: uplId,
      original_name: "GP-EPC-Referral-Marcus-Okafor.pdf",
      canonical_name: "marcus-okafor_gp-referral_01.pdf",
      detected_mime: "application/pdf",
      size_bytes: pdfBlob.size,
      sha256: syntheticSha256(uplId),
      created_at: r3Created,
    });
    r3Ref.status = "approved";
  }
  const r3Consent = r3Items.find((i) => i.kind === "checkbox");
  if (r3Consent) {
    r3Consent.rawValue = "confirmed";
    r3Consent.status = "approved";
  }

  const reqHealth: DemoRequestRecord = {
    id: "req_demo_health",
    magicToken: "demo-health",
    title: "Allied Health New Patient Intake",
    client_name: "Marcus Okafor",
    client_email: "marcus.okafor@example.com.au",
    client_subject: null,
    welcome_note: null,
    status: "completed",
    require_otp: false,
    reminder_interval_days: 3,
    max_reminders: 4,
    reminders_sent: 0,
    reminders_paused: false,
    next_reminder_at: null,
    purge_after_days: 14,
    purge_at: addDaysIso(r3Completed, 14),
    due_at: null,
    last_opened_at: new Date(nowMs - 48 * 3600_000).toISOString(),
    last_manual_reminder_at: null,
    completed_at: r3Completed,
    is_demo: true,
    created_at: r3Created,
    items: r3Items,
    auditEvents: [
      {
        id: "aud_demo_health_2",
        actor: "operator",
        action: "request.approved_all_submitted",
        meta_json: JSON.stringify({ count: 4 }),
        created_at: r3Completed,
      },
      {
        id: "aud_demo_health_1",
        actor: "operator",
        action: "request.created",
        meta_json: JSON.stringify({
          clientEmail: "marcus.okafor@example.com.au",
          itemCount: r3Items.length,
          requireOtp: false,
          isDemo: true,
        }),
        created_at: r3Created,
      },
    ],
  };

  const taxUrl = outboxPortalUrl("demo-tax");
  const basUrl = outboxPortalUrl("demo-bas");
  const healthUrl = outboxPortalUrl("demo-health");

  const outbox: OutboxEmailDto[] = [
    {
      id: "eml_demo_4",
      request_id: "req_demo_tax",
      recipient: "claire.nguyen@example.com.au",
      subject: "One item needs another look: Private Health Insurance Tax Statement",
      text_body: [
        "Hi Claire Nguyen,",
        "",
        'Harbour Advisory reviewed "Private Health Insurance Tax Statement" on "FY26 Individual Tax Return Pack" and asked for an update:',
        "",
        "Uploaded page 1 only. Please include the rebate summary on page 2.",
        "",
        "Open your checklist to update this item:",
        taxUrl,
      ].join("\n"),
      html_body: renderEmailHtml({
        brandName: "Harbour Advisory",
        accentColor: "#0F5243",
        heading: "One item needs another look",
        bodyHtml:
          "<p>Hi Claire Nguyen,</p><p>Harbour Advisory reviewed <strong>Private Health Insurance Tax Statement</strong> and asked for an update:</p><p style=\"padding:10px 12px;background:#FFF8EB;border:1px solid #F5D9A8;border-radius:8px;\">Uploaded page 1 only. Please include the rebate summary on page 2.</p>",
        cta: { label: "Update item", url: taxUrl },
      }),
      kind: "revision",
      is_demo: 1,
      created_at: new Date(nowMs - 90 * 60_000).toISOString(),
    },
    {
      id: "eml_demo_3",
      request_id: "req_demo_bas",
      recipient: "accounts@harbourline.example.com.au",
      subject: "Reminder: 2 items left for Q3 BAS & Supplier Pack",
      text_body: [
        "Hi Harbourline Plumbing Pty Ltd,",
        "",
        'A quick reminder from Harbour Advisory. Still needed for "Q3 BAS & Supplier Pack":',
        "",
        "  - Australian Business Number (ABN)",
        "  - Director BAS Lodgement Authority",
        "",
        "Open your secure checklist:",
        basUrl,
      ].join("\n"),
      html_body: renderEmailHtml({
        brandName: "Harbour Advisory",
        accentColor: "#0F5243",
        heading: "2 items left",
        bodyHtml:
          "<p>Hi Harbourline Plumbing Pty Ltd, a quick reminder from Harbour Advisory. Still needed for <strong>Q3 BAS &amp; Supplier Pack</strong>:</p><ul><li>Australian Business Number (ABN)</li><li>Director BAS Lodgement Authority</li></ul>",
        cta: { label: "Continue checklist", url: basUrl },
      }),
      kind: "reminder",
      is_demo: 1,
      created_at: new Date(nowMs - 20 * 3600_000).toISOString(),
    },
    {
      id: "eml_demo_2",
      request_id: "req_demo_tax",
      recipient: "claire.nguyen@example.com.au",
      subject: "Documents for your FY26 tax return",
      text_body: [
        "Hi Claire Nguyen,",
        "",
        'Harbour Advisory has asked for 6 items for "FY26 Individual Tax Return Pack".',
        "",
        "Open your secure checklist:",
        taxUrl,
      ].join("\n"),
      html_body: renderEmailHtml({
        brandName: "Harbour Advisory",
        accentColor: "#0F5243",
        heading: "FY26 Individual Tax Return Pack",
        bodyHtml:
          "<p>Hi Claire Nguyen,</p><p>Harbour Advisory has asked for 6 items. Please upload your receipts and confirm your bank BSB before Friday.</p>",
        cta: { label: "Open checklist", url: taxUrl },
      }),
      kind: "invite",
      is_demo: 1,
      created_at: r1Created,
    },
    {
      id: "eml_demo_1",
      request_id: "req_demo_health",
      recipient: "marcus.okafor@example.com.au",
      subject: "Harbour Advisory needs a few documents from you",
      text_body: [
        "Hi Marcus Okafor,",
        "",
        'Harbour Advisory has asked for 4 items for "Allied Health New Patient Intake".',
        "",
        "Open your secure checklist:",
        healthUrl,
      ].join("\n"),
      html_body: renderEmailHtml({
        brandName: "Harbour Advisory",
        accentColor: "#0F5243",
        heading: "Allied Health New Patient Intake",
        bodyHtml:
          "<p>Hi Marcus Okafor,</p><p>Harbour Advisory has asked for 4 items for your new patient intake.</p>",
        cta: { label: "Open checklist", url: healthUrl },
      }),
      kind: "invite",
      is_demo: 1,
      created_at: r3Created,
    },
  ];

  return {
    requests: [reqTax, reqBas, reqHealth],
    outbox,
  };
}

function createInitialState(): DemoState {
  const nowMs = Date.now();
  const baseCreated = new Date(nowMs - 14 * 86400_000).toISOString();
  const templates: TemplateDto[] = BUILTIN_TEMPLATE_SPECS.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    is_builtin: true,
    items: t.items.map((item) => ({ ...item })),
    created_at: baseCreated,
  }));
  const blobs = new Map<string, Blob>();
  const { requests, outbox } = makeSeedRequestsAndOutbox(nowMs, templates, blobs);

  return {
    seq: 1,
    loggedIn: true,
    user: {
      id: "usr_demo",
      email: "ops@harbouradvisory.example.com.au",
      displayName: "Practice Operations",
    },
    workspace: {
      id: "ws_demo",
      name: "Harbour Advisory",
      slug: "harbour-advisory",
      plan: "self_hosted",
      max_active_requests: 0,
      max_storage_bytes: 0,
      webhook_url: null,
      has_webhook_secret: false,
      brand_color: "#0F5243",
      has_logo: false,
      support_email: "help@harbouradvisory.example.com.au",
      support_phone: "+61 3 9000 4120",
      created_at: baseCreated,
    },
    logoDataUrl: null,
    webhookSecret: "",
    email: {
      source: "env",
      backend: "console",
      from: "Harbour Advisory <noreply@harbouradvisory.example.com.au>",
      replyTo: "help@harbouradvisory.example.com.au",
      smtp: { host: "", port: 587, secure: false, user: "", hasPass: false },
      resend: { hasApiKey: false },
    },
    templates,
    requests,
    outbox,
    apiKeys: [],
    webhookDeliveries: [],
    blobs,
    otpVerifiedRequestIds: new Set<string>(),
  };
}

const DEMO_STORAGE_KEY = "gathergate-demo-state-v1";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const uploadedBlobData = new Map<string, { type: string; b64: string }>();

function persistDemoState(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const payload = {
      seq: state.seq,
      loggedIn: state.loggedIn,
      user: state.user,
      workspace: state.workspace,
      logoDataUrl: state.logoDataUrl,
      webhookSecret: state.webhookSecret,
      email: state.email,
      templates: state.templates,
      requests: state.requests,
      outbox: state.outbox,
      apiKeys: state.apiKeys,
      webhookDeliveries: state.webhookDeliveries,
      otpVerifiedRequestIds: [...state.otpVerifiedRequestIds],
      uploadedBlobs: [...uploadedBlobData.entries()],
    };
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota or SecurityError in restricted environments
  }
}

function loadDemoState(): DemoState {
  const fresh = createInitialState();
  if (typeof window === "undefined" || !window.localStorage) return fresh;
  try {
    const raw = window.localStorage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return fresh;
    const saved = JSON.parse(raw) as Partial<DemoState> & {
      otpVerifiedRequestIds?: string[];
      uploadedBlobs?: Array<[string, { type: string; b64: string }]>;
    };
    if (!Array.isArray(saved.requests) || !Array.isArray(saved.templates)) return fresh;
    const blobs = new Map<string, Blob>(fresh.blobs);
    uploadedBlobData.clear();
    for (const [id, entry] of saved.uploadedBlobs ?? []) {
      const bytes = base64ToBytes(entry.b64);
      blobs.set(id, new Blob([bytes.buffer as ArrayBuffer], { type: entry.type }));
      uploadedBlobData.set(id, entry);
    }
    const restoredLogo =
      typeof saved.logoDataUrl === "string" && SAFE_LOGO_DATA_URL_RE.test(saved.logoDataUrl)
        ? saved.logoDataUrl
        : null;
    return {
      ...fresh,
      seq: typeof saved.seq === "number" ? saved.seq : fresh.seq,
      loggedIn: typeof saved.loggedIn === "boolean" ? saved.loggedIn : fresh.loggedIn,
      user: saved.user ?? fresh.user,
      workspace: saved.workspace ?? fresh.workspace,
      logoDataUrl: saved.logoDataUrl !== undefined ? restoredLogo : fresh.logoDataUrl,
      webhookSecret: typeof saved.webhookSecret === "string" ? saved.webhookSecret : fresh.webhookSecret,
      email: saved.email ?? fresh.email,
      templates: saved.templates,
      requests: saved.requests,
      outbox: Array.isArray(saved.outbox) ? saved.outbox : fresh.outbox,
      apiKeys: Array.isArray(saved.apiKeys) ? saved.apiKeys : fresh.apiKeys,
      webhookDeliveries: Array.isArray(saved.webhookDeliveries)
        ? saved.webhookDeliveries
        : fresh.webhookDeliveries,
      blobs,
      otpVerifiedRequestIds: new Set(saved.otpVerifiedRequestIds ?? []),
    };
  } catch {
    return fresh;
  }
}

let state: DemoState = loadDemoState();

export function resetDemoState(): void {
  uploadedBlobData.clear();
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.removeItem(DEMO_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }
  state = createInitialState();
}

function nextId(prefix: string): string {
  state.seq += 1;
  return `${prefix}_demo_${state.seq}`;
}

function getBranding(): BrandingDto {
  return {
    name: state.workspace.name,
    brandColor: state.workspace.brand_color,
    logoDataUrl: state.logoDataUrl,
    supportEmail: state.workspace.support_email,
    supportPhone: state.workspace.support_phone,
  };
}

function getStorageBytes(): number {
  let total = 0;
  for (const req of state.requests) {
    if (req.status === "purged") continue;
    for (const item of req.items) {
      for (const upload of item.uploads) {
        total += upload.size_bytes;
      }
    }
  }
  return total;
}

function countAwaitingReview(): number {
  return state.requests.filter(
    (r) => (r.status === "open" || r.status === "in_review") && r.items.some((i) => i.status === "submitted")
  ).length;
}

function logAudit(
  req: DemoRequestRecord,
  actor: "operator" | "client" | "system",
  action: string,
  meta: Record<string, unknown>
): void {
  req.auditEvents.unshift({
    id: nextId("aud"),
    actor,
    action,
    meta_json: JSON.stringify(meta),
    created_at: new Date().toISOString(),
  });
}

function addOutboxEmail(params: {
  requestId: string | null;
  recipient: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  kind: string;
  isDemo: boolean;
}): void {
  state.outbox.unshift({
    id: nextId("eml"),
    request_id: params.requestId,
    recipient: params.recipient.trim().toLowerCase(),
    subject: params.subject,
    text_body: params.textBody,
    html_body: params.htmlBody,
    kind: params.kind,
    is_demo: params.isDemo ? 1 : 0,
    created_at: new Date().toISOString(),
  });
}

function recomputeRequestStatus(req: DemoRequestRecord, nowIso = new Date().toISOString()): void {
  if (req.status === "purged" || req.status === "expired") return;
  const requiredItems = req.items.filter((i) => i.required);
  const checkSet = requiredItems.length > 0 ? requiredItems : req.items;
  const allApproved = checkSet.length > 0 && checkSet.every((i) => i.status === "approved");
  const allSubmittedOrApproved =
    checkSet.length > 0 &&
    checkSet.every((i) => i.status === "submitted" || i.status === "approved");
  const hasRejected = req.items.some((i) => i.status === "rejected");
  const hasSubmitted = req.items.some((i) => i.status === "submitted");

  if (allApproved && !hasRejected && !hasSubmitted) {
    req.status = "completed";
    req.completed_at = req.completed_at || nowIso;
    req.purge_at = addDaysIso(req.completed_at, req.purge_after_days);
    req.next_reminder_at = null;
  } else if (allSubmittedOrApproved && !hasRejected) {
    req.status = "in_review";
    req.completed_at = null;
    req.purge_at = null;
    req.next_reminder_at = null;
  } else {
    req.status = "open";
    req.completed_at = null;
    req.purge_at = null;
    req.next_reminder_at =
      req.next_reminder_at ||
      (req.reminders_sent < req.max_reminders && req.reminder_interval_days > 0
        ? addDaysIso(nowIso, req.reminder_interval_days)
        : null);
  }
}

function formatItemForOperator(item: DemoItemRecord): RequestItemDto {
  let displayValue: string | null = null;
  let isSensitiveMasked = false;
  if (item.rawValue !== null) {
    if (SENSITIVE_VALIDATORS.has(item.validator)) {
      displayValue = maskSensitiveValue(item.validator, item.rawValue);
      isSensitiveMasked = true;
    } else {
      displayValue = item.rawValue;
    }
  }
  return {
    id: item.id,
    position: item.position,
    section: item.section,
    label: item.label,
    help_text: item.help_text,
    kind: item.kind,
    required: item.required,
    validator: item.validator,
    config: { ...item.config },
    status: item.status,
    displayValue,
    isSensitiveMasked,
    review_note: item.review_note,
    client_note: item.client_note,
    client_na: item.client_na,
    updated_at: item.updated_at,
    uploads: item.uploads.map((u) => ({ ...u })),
  };
}

function formatItemForClient(item: DemoItemRecord): RequestItemDto {
  let currentValue: string | null = null;
  let isSensitiveMasked = false;
  if (item.rawValue !== null) {
    if (SENSITIVE_VALIDATORS.has(item.validator)) {
      currentValue = maskSensitiveValue(item.validator, item.rawValue);
      isSensitiveMasked = true;
    } else {
      currentValue = item.rawValue;
    }
  }
  return {
    id: item.id,
    position: item.position,
    section: item.section,
    label: item.label,
    help_text: item.help_text,
    kind: item.kind,
    required: item.required,
    validator: item.validator,
    validator_hint: getValidatorHint(item.validator) ?? null,
    config: { ...item.config },
    status: item.status,
    currentValue,
    isSensitiveMasked,
    review_note: item.review_note,
    client_note: item.client_note,
    client_na: item.client_na,
    updated_at: item.updated_at,
    uploads: item.uploads.map(({ sha256: _sha, ...u }) => ({ ...u })),
  };
}

function summarizeRequest(r: DemoRequestRecord): RequestSummaryDto {
  return {
    id: r.id,
    title: r.title,
    client_name: r.client_name,
    client_email: r.client_email,
    status: r.status,
    require_otp: r.require_otp,
    reminders_sent: r.reminders_sent,
    max_reminders: r.max_reminders,
    reminders_paused: r.reminders_paused,
    next_reminder_at: r.next_reminder_at,
    purge_at: r.purge_at,
    due_at: r.due_at,
    last_opened_at: r.last_opened_at,
    is_demo: r.is_demo,
    created_at: r.created_at,
    total_items: r.items.length,
    approved_items: r.items.filter((i) => i.status === "approved").length,
    submitted_items: r.items.filter((i) => i.status === "submitted").length,
    rejected_items: r.items.filter((i) => i.status === "rejected").length,
    portal_url: outboxPortalUrl(r.magicToken),
  };
}

function normalizeTemplateItems(raw: unknown): TemplateItemSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError("At least one checklist item is required.", 400);
  }
  return raw.map((entry, idx) => {
    const item = (entry ?? {}) as Partial<TemplateItemSpec>;
    const label = String(item.label || "").trim();
    if (!label) throw new ApiError(`Item #${idx + 1} is missing a label.`, 400);
    const kind = item.kind;
    if (kind !== "file" && kind !== "text" && kind !== "textarea" && kind !== "checkbox") {
      throw new ApiError(`Item "${label}" has invalid kind.`, 400);
    }
    const validator = item.validator || "none";
    if (!isKnownValidator(validator)) {
      throw new ApiError(`Item "${label}" uses unknown validator "${validator}".`, 400);
    }
    return {
      section: String(item.section || "General").trim() || "General",
      label,
      helpText: String(item.helpText || "").trim(),
      kind,
      required: Boolean(item.required),
      validator,
      allowedGroups: Array.isArray(item.allowedGroups) ? [...item.allowedGroups] : undefined,
      maxFileMb:
        typeof item.maxFileMb === "number" && Number.isFinite(item.maxFileMb) && item.maxFileMb > 0
          ? Math.min(MAX_ITEM_FILE_MB, Math.max(1, Math.floor(item.maxFileMb)))
          : 20,
      multiple: Boolean(item.multiple),
      slug: item.slug ? slugify(item.slug) : slugify(label, `item-${idx + 1}`),
    };
  });
}

function parseJsonBody<T>(init?: RequestInit): T {
  if (!init?.body || typeof init.body !== "string") return {} as T;
  try {
    return JSON.parse(init.body) as T;
  } catch {
    return {} as T;
  }
}

function requireOperator(): void {
  if (!state.loggedIn) {
    throw new ApiError("Unauthorized", 401);
  }
}

function isClientVerified(req: DemoRequestRecord): boolean {
  return !req.require_otp || state.otpVerifiedRequestIds.has(req.id);
}

function findRequestByToken(token: string): DemoRequestRecord | undefined {
  return state.requests.find((r) => r.magicToken === token);
}

function findUpload(uploadId: string): { request: DemoRequestRecord; item: DemoItemRecord; upload: UploadDto } | null {
  for (const request of state.requests) {
    for (const item of request.items) {
      const upload = item.uploads.find((u) => u.id === uploadId);
      if (upload) return { request, item, upload };
    }
  }
  return null;
}

function buildSessionResponse(): SessionResponse {
  return {
    needsSetup: false,
    multiTenant: false,
    user: state.loggedIn ? { ...state.user } : null,
    workspace: state.loggedIn ? { ...state.workspace } : null,
    readiness: {
      storageBackend: "browser-demo",
      emailBackend: state.email.backend,
      cronIntervalMinutes: 5,
      defaultPurgeDays: 30,
      masterKeyAutoGenerated: false,
      hasDemoData: state.loggedIn ? state.requests.some((r) => r.is_demo) : false,
      outboxCount: state.loggedIn ? state.outbox.length : 0,
      awaitingReviewCount: state.loggedIn ? countAwaitingReview() : 0,
    },
  };
}

function buildSettingsResponse(): SettingsResponse {
  return {
    webhookUrl: state.workspace.webhook_url || "",
    webhookSecret: state.webhookSecret,
    branding: getBranding(),
    account: {
      id: state.user.id,
      email: state.user.email,
      displayName: state.user.displayName,
      workspaceName: state.workspace.name,
    },
    email: {
      ...state.email,
      smtp: { ...state.email.smtp },
      resend: { ...state.email.resend },
    },
    readiness: {
      masterKeyConfigured: true,
      masterKeySource: "env",
      masterKeyAutoGenerated: false,
      storageBackend: "browser-demo",
      emailBackend: state.email.backend,
      emailFrom: state.email.from,
      cronIntervalMinutes: 5,
      defaultPurgeDays: 30,
      hasDemoData: state.requests.some((r) => r.is_demo),
      storageBytes: getStorageBytes(),
      outboxCount: state.outbox.length,
    },
  };
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

export async function demoApiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const res = await handleDemoApiJson<T>(url, init);
  if (method !== "GET") {
    persistDemoState();
  }
  return res;
}

async function handleDemoApiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const [pathname] = url.split("?");

  if (method === "GET" && pathname === "/api/session") {
    return buildSessionResponse() as T;
  }

  if (method === "POST" && pathname === "/api/setup") {
    throw new ApiError("Setup has already been completed.", 409);
  }

  if (method === "POST" && pathname === "/api/signup") {
    throw new ApiError("Multi-tenant signup is disabled.", 403);
  }

  if (method === "POST" && pathname === "/api/login") {
    const body = parseJsonBody<{ email?: string; password?: string }>(init);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email.includes("@") || !password) {
      throw new ApiError("Invalid email or password.", 401);
    }
    state.loggedIn = true;
    state.user = { ...state.user, email };
    return {
      ok: true,
      user: { ...state.user },
      workspace: { ...state.workspace },
    } as T;
  }

  if (method === "POST" && pathname === "/api/logout") {
    state.loggedIn = false;
    return { ok: true } as T;
  }

  // Client portal routes (passwordless magic token)
  const clientMatch = pathname.match(/^\/api\/client\/([^/]+)$/);
  if (method === "GET" && clientMatch) {
    const req = findRequestByToken(decodeURIComponent(clientMatch[1]));
    if (!req) throw new ApiError("Invalid or expired checklist link.", 404);
    if (req.status === "expired") throw new ApiError("This checklist link has expired.", 410);
    const branding = getBranding();

    if (req.status === "purged") {
      return {
        requiresOtp: false,
        workspaceName: state.workspace.name,
        branding,
        request: {
          id: req.id,
          title: req.title,
          client_name: req.client_name,
          status: req.status,
          due_at: req.due_at,
          purge_at: req.purge_at,
        },
        items: [],
      } satisfies ClientPortalResponse as T;
    }

    if (!isClientVerified(req)) {
      return {
        requiresOtp: true,
        workspaceName: state.workspace.name,
        branding,
        request: {
          id: req.id,
          title: req.title,
          client_name: req.client_name,
          maskedEmail: maskEmail(req.client_email),
          status: req.status,
          due_at: req.due_at,
        },
      } satisfies ClientPortalResponse as T;
    }

    req.last_opened_at = new Date().toISOString();
    return {
      requiresOtp: false,
      workspaceName: state.workspace.name,
      branding,
      request: {
        id: req.id,
        title: req.title,
        client_name: req.client_name,
        client_subject: req.client_subject,
        welcome_note: req.welcome_note,
        status: req.status,
        due_at: req.due_at,
        completed_at: req.completed_at,
        purge_at: req.purge_at,
      },
      items: req.items.map(formatItemForClient),
    } satisfies ClientPortalResponse as T;
  }

  const otpSendMatch = pathname.match(/^\/api\/client\/([^/]+)\/otp\/send$/);
  if (method === "POST" && otpSendMatch) {
    const req = findRequestByToken(decodeURIComponent(otpSendMatch[1]));
    if (!req || req.status === "purged" || req.status === "expired") {
      throw new ApiError("Not found", 404);
    }
    if (!req.require_otp) {
      throw new ApiError("Verification code is not required for this checklist.", 400);
    }
    addOutboxEmail({
      requestId: req.id,
      recipient: req.client_email,
      subject: `${DEMO_OTP_CODE} is your verification code`,
      textBody: [
        `Hi ${req.client_name},`,
        "",
        `Use this code to open "${req.title}" from ${state.workspace.name}:`,
        "",
        DEMO_OTP_CODE,
        "",
        "It expires in 15 minutes.",
      ].join("\n"),
      htmlBody: renderEmailHtml({
        brandName: state.workspace.name,
        accentColor: state.workspace.brand_color || "#0F5243",
        heading: "Your verification code",
        bodyHtml: `<p>Use this code to open <strong>${escapeHtml(req.title)}</strong>:</p><p style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:6px;">${DEMO_OTP_CODE}</p>`,
      }),
      kind: "otp",
      isDemo: req.is_demo,
    });
    logAudit(req, "client", "otp.sent", {});
    return { ok: true, maskedEmail: maskEmail(req.client_email) } as T;
  }

  const otpVerifyMatch = pathname.match(/^\/api\/client\/([^/]+)\/otp\/verify$/);
  if (method === "POST" && otpVerifyMatch) {
    const req = findRequestByToken(decodeURIComponent(otpVerifyMatch[1]));
    if (!req || req.status === "purged" || req.status === "expired") {
      throw new ApiError("Not found", 404);
    }
    if (!req.require_otp) {
      throw new ApiError("Verification code is not required for this checklist.", 400);
    }
    const body = parseJsonBody<{ code?: string }>(init);
    if (String(body.code || "").trim() !== DEMO_OTP_CODE) {
      throw new ApiError("Incorrect 6-digit code.", 400);
    }
    state.otpVerifiedRequestIds.add(req.id);
    logAudit(req, "client", "otp.verified", {});
    return { ok: true } as T;
  }

  const clientItemMatch = pathname.match(/^\/api\/client\/([^/]+)\/items\/([^/]+)$/);
  if (method === "POST" && clientItemMatch) {
    const req = findRequestByToken(decodeURIComponent(clientItemMatch[1]));
    const itemId = decodeURIComponent(clientItemMatch[2]);
    if (!req || req.status === "purged" || req.status === "completed" || req.status === "expired") {
      throw new ApiError("Checklist is closed.", 403);
    }
    if (!isClientVerified(req)) {
      throw new ApiError("Email verification required.", 401);
    }
    const item = req.items.find((i) => i.id === itemId);
    if (!item) throw new ApiError("Item not found", 404);
    if (item.status === "approved") {
      throw new ApiError("Approved items are locked and cannot be modified.", 409);
    }

    const nowIso = new Date().toISOString();
    if (item.kind === "checkbox") {
      const body = parseJsonBody<{ checked?: boolean | string }>(init);
      const checked = body.checked === true || body.checked === "1" || body.checked === "true";
      if (!checked) throw new ApiError("Please confirm the declaration checkbox.", 400);
      item.rawValue = "confirmed";
      item.status = "submitted";
      item.review_note = null;
      item.client_na = false;
      item.updated_at = nowIso;
      recomputeRequestStatus(req, nowIso);
      logAudit(req, "client", "item.submitted", { itemId: item.id, kind: "checkbox" });
      return {
        ok: true,
        requestStatus: req.status,
        item: { status: item.status, currentValue: "confirmed", isSensitiveMasked: false },
      } as T;
    }

    if (item.kind === "text" || item.kind === "textarea") {
      const body = parseJsonBody<{ value?: string }>(init);
      const rawValue = String(body.value || "");
      const maxChars = item.kind === "textarea" ? MAX_TEXTAREA_ITEM_CHARS : MAX_TEXT_ITEM_CHARS;
      if (rawValue.length > maxChars) {
        throw new ApiError(`Value exceeds maximum length of ${maxChars} characters.`, 400);
      }
      const check = validateTextValue(item.validator, rawValue);
      if (!check.valid || !check.normalised) {
        throw new ApiError(check.error || "Invalid value", 400);
      }
      item.rawValue = check.normalised;
      item.status = "submitted";
      item.review_note = null;
      item.client_na = false;
      item.updated_at = nowIso;
      recomputeRequestStatus(req, nowIso);
      logAudit(req, "client", "item.submitted", {
        itemId: item.id,
        kind: item.kind,
        validator: item.validator,
      });
      const isSensitiveMasked = SENSITIVE_VALIDATORS.has(item.validator);
      return {
        ok: true,
        requestStatus: req.status,
        item: {
          status: item.status,
          currentValue: isSensitiveMasked
            ? maskSensitiveValue(item.validator, check.normalised)
            : check.normalised,
          isSensitiveMasked,
        },
      } as T;
    }

    throw new ApiError("Multipart file upload expected.", 400);
  }

  const clientNoteMatch = pathname.match(/^\/api\/client\/([^/]+)\/items\/([^/]+)\/note$/);
  if (method === "PUT" && clientNoteMatch) {
    const req = findRequestByToken(decodeURIComponent(clientNoteMatch[1]));
    const itemId = decodeURIComponent(clientNoteMatch[2]);
    if (!req || req.status === "purged" || req.status === "completed" || req.status === "expired") {
      throw new ApiError("Checklist is closed.", 403);
    }
    if (!isClientVerified(req)) throw new ApiError("Email verification required.", 401);
    const item = req.items.find((i) => i.id === itemId);
    if (!item) throw new ApiError("Item not found", 404);
    if (item.status === "approved") {
      throw new ApiError("Approved items are locked and cannot be modified.", 409);
    }
    const body = parseJsonBody<{ note?: string; notApplicable?: boolean }>(init);
    const note = String(body.note ?? "").trim();
    const notApplicable = body.notApplicable === true;
    if (note.length > MAX_CLIENT_NOTE_CHARS) {
      throw new ApiError(`Notes are limited to ${MAX_CLIENT_NOTE_CHARS} characters.`, 400);
    }
    if (notApplicable && !note) {
      throw new ApiError("Tell us briefly why this does not apply.", 400);
    }

    const nowIso = new Date().toISOString();
    const wasNa = item.client_na;
    item.client_note = note || null;
    item.updated_at = nowIso;
    if (notApplicable) {
      item.client_na = true;
      item.status = "submitted";
      item.review_note = null;
    } else {
      item.client_na = false;
      if (wasNa && item.status === "submitted" && item.rawValue === null && item.uploads.length === 0) {
        item.status = "pending";
      }
    }
    recomputeRequestStatus(req, nowIso);
    logAudit(req, "client", notApplicable ? "item.marked_na" : "item.note_saved", { itemId: item.id });
    return {
      ok: true,
      requestStatus: req.status,
      item: { status: item.status, client_note: item.client_note, client_na: item.client_na },
    } as T;
  }

  const clientUploadDelMatch = pathname.match(/^\/api\/client\/([^/]+)\/uploads\/([^/]+)$/);
  if (method === "DELETE" && clientUploadDelMatch) {
    const req = findRequestByToken(decodeURIComponent(clientUploadDelMatch[1]));
    const uploadId = decodeURIComponent(clientUploadDelMatch[2]);
    if (!req) throw new ApiError("File not found", 404);
    if (req.status === "purged" || req.status === "completed" || req.status === "expired") {
      throw new ApiError("Checklist is closed.", 403);
    }
    if (!isClientVerified(req)) throw new ApiError("Email verification required.", 401);

    const targetItem = req.items.find((it) => it.uploads.some((u) => u.id === uploadId));
    if (!targetItem) throw new ApiError("File not found", 404);
    if (targetItem.status === "approved") {
      throw new ApiError("Approved items are locked and cannot be modified.", 409);
    }

    const removed = targetItem.uploads.find((u) => u.id === uploadId)!;
    targetItem.uploads = targetItem.uploads.filter((u) => u.id !== uploadId);
    state.blobs.delete(uploadId);
    uploadedBlobData.delete(uploadId);
    const nowIso = new Date().toISOString();
    if (targetItem.status === "submitted" && !targetItem.client_na && targetItem.uploads.length === 0) {
      targetItem.status = "pending";
      targetItem.updated_at = nowIso;
    }
    recomputeRequestStatus(req, nowIso);
    logAudit(req, "client", "item.file_removed", {
      itemId: targetItem.id,
      originalName: removed.original_name,
    });
    return { ok: true, requestStatus: req.status, item: { status: targetItem.status } } as T;
  }

  // Operator routes
  requireOperator();

  if (method === "GET" && pathname === "/api/requests") {
    const enriched = [...state.requests]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(summarizeRequest);
    const demoCandidate =
      enriched.find(
        (r) => r.is_demo && !r.require_otp && r.status !== "completed" && r.status !== "purged"
      ) ?? enriched.find((r) => r.is_demo && r.status !== "purged");

    return {
      requests: enriched,
      kpis: {
        active: enriched.filter((r) => r.status === "open" || r.status === "in_review").length,
        awaitingReview: enriched.filter((r) => r.submitted_items > 0 && r.status !== "purged").length,
        needsRevision: enriched.filter((r) => r.rejected_items > 0 && r.status !== "purged").length,
        completed: enriched.filter((r) => r.status === "completed").length,
      },
      storageBytes: getStorageBytes(),
      activeCount: enriched.filter((r) => r.status === "open" || r.status === "in_review").length,
      workspace: { ...state.workspace },
      hasDemoData: enriched.some((r) => r.is_demo),
      demoPortalUrl: demoCandidate?.portal_url ?? null,
    } satisfies RequestsListResponse as T;
  }

  if (method === "POST" && pathname === "/api/requests") {
    const body = parseJsonBody<{
      templateId?: string;
      title?: string;
      clientSubject?: string;
      welcomeNote?: string;
      clientName?: string;
      clientEmail?: string;
      items?: unknown;
      requireOtp?: boolean;
      sendInvite?: boolean;
      reminderIntervalDays?: number;
      maxReminders?: number;
      purgeAfterDays?: number;
      dueAt?: string | null;
    }>(init);

    const template = body.templateId ? state.templates.find((t) => t.id === body.templateId) : undefined;
    const title = String(body.title || "").trim();
    const clientName = String(body.clientName || "").trim();
    const clientEmail = String(body.clientEmail || "").trim().toLowerCase();
    if ((!template && !body.items) || !title || !clientName || !clientEmail.includes("@")) {
      throw new ApiError("Select a template and fill in title, client name, and valid client email.", 400);
    }

    const specs = body.items ? normalizeTemplateItems(body.items) : template!.items;
    const nowIso = new Date().toISOString();
    const reqId = nextId("req");
    const magicToken = nextId("tok");
    const reminderIntervalDays = Math.max(0, Number(body.reminderIntervalDays ?? 3) || 0);
    const maxReminders = Math.max(0, Number(body.maxReminders ?? 4) || 0);
    const hasSensitive = specs.some((i) => SENSITIVE_VALIDATORS.has(i.validator));
    const defaultPurge = hasSensitive ? 14 : 30;
    const purgeAfterDays =
      body.purgeAfterDays !== undefined && body.purgeAfterDays !== null
        ? Math.max(1, Math.min(365, Math.floor(Number(body.purgeAfterDays)) || defaultPurge))
        : defaultPurge;

    const reqRecord: DemoRequestRecord = {
      id: reqId,
      magicToken,
      title,
      client_name: clientName,
      client_email: clientEmail,
      client_subject: body.clientSubject?.trim() || null,
      welcome_note: body.welcomeNote?.trim() || null,
      status: "open",
      require_otp: Boolean(body.requireOtp),
      reminder_interval_days: reminderIntervalDays,
      max_reminders: maxReminders,
      reminders_sent: 0,
      reminders_paused: false,
      next_reminder_at:
        maxReminders > 0 && reminderIntervalDays > 0 ? addDaysIso(nowIso, reminderIntervalDays) : null,
      purge_after_days: purgeAfterDays,
      purge_at: null,
      due_at: body.dueAt ? String(body.dueAt) : null,
      last_opened_at: null,
      last_manual_reminder_at: null,
      completed_at: null,
      is_demo: false,
      created_at: nowIso,
      items: specs.map((spec, idx) => ({
        id: nextId("itm"),
        position: idx,
        section: spec.section || "General",
        label: spec.label,
        help_text: spec.helpText || "",
        kind: spec.kind,
        required: Boolean(spec.required),
        validator: spec.validator || "none",
        config: {
          allowedGroups: spec.allowedGroups,
          maxFileMb: spec.maxFileMb ?? 20,
          multiple: Boolean(spec.multiple),
          slug: spec.slug || slugify(spec.label, `item-${idx + 1}`),
        },
        status: "pending",
        rawValue: null,
        review_note: null,
        client_note: null,
        client_na: false,
        updated_at: nowIso,
        uploads: [],
      })),
      auditEvents: [],
    };
    logAudit(reqRecord, "operator", "request.created", {
      clientEmail,
      itemCount: specs.length,
      requireOtp: reqRecord.require_otp,
      isDemo: false,
    });

    const outboxUrl = outboxPortalUrl(magicToken);
    if (body.sendInvite !== false) {
      addOutboxEmail({
        requestId: reqId,
        recipient: clientEmail,
        subject: reqRecord.client_subject || `${state.workspace.name} needs a few documents from you`,
        textBody: [
          `Hi ${clientName},`,
          "",
          `${state.workspace.name} has asked for ${specs.length} items for "${title}".`,
          "",
          "Open your secure checklist:",
          outboxUrl,
        ].join("\n"),
        htmlBody: renderEmailHtml({
          brandName: state.workspace.name,
          accentColor: state.workspace.brand_color || "#0F5243",
          heading: title,
          bodyHtml: `<p>Hi ${escapeHtml(clientName)},</p><p>${escapeHtml(state.workspace.name)} has asked for ${specs.length} items.</p>`,
          cta: { label: "Open checklist", url: outboxUrl },
        }),
        kind: "invite",
        isDemo: false,
      });
      logAudit(reqRecord, "system", "invite.sent", { to: clientEmail });
    }

    state.requests.unshift(reqRecord);
    return { id: reqId, portalUrl: outboxPortalUrl(magicToken) } as T;
  }

  if (method === "POST" && pathname === "/api/requests/bulk-reminders") {
    const body = parseJsonBody<{ ids?: unknown; paused?: unknown }>(init);
    if (
      !Array.isArray(body.ids) ||
      body.ids.length === 0 ||
      body.ids.length > 200 ||
      !body.ids.every((x) => typeof x === "string" && x.length > 0) ||
      typeof body.paused !== "boolean"
    ) {
      throw new ApiError("Provide 1 to 200 request IDs and a paused boolean.", 400);
    }
    const updatedIds: string[] = [];
    for (const reqId of new Set(body.ids)) {
      const req = state.requests.find((r) => r.id === reqId);
      if (!req || req.status === "completed" || req.status === "purged" || req.status === "expired") {
        continue;
      }
      if (req.reminders_paused !== body.paused) {
        req.reminders_paused = body.paused;
        logAudit(req, "operator", body.paused ? "reminders.paused" : "reminders.resumed", {});
        updatedIds.push(req.id);
      }
    }
    return { ok: true, updatedIds, paused: body.paused } as T;
  }

  const reqDetailMatch = pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (method === "GET" && reqDetailMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(reqDetailMatch[1]));
    if (!req) throw new ApiError("Not found", 404);
    const { items, auditEvents, magicToken, ...rest } = req;
    return {
      request: rest,
      portalUrl: outboxPortalUrl(magicToken),
      items: items.map(formatItemForOperator),
      auditEvents: [...auditEvents],
    } satisfies RequestDetailResponse as T;
  }

  if (method === "PATCH" && reqDetailMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(reqDetailMatch[1]));
    if (!req) throw new ApiError("Not found", 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      throw new ApiError("Checklist is closed.", 409);
    }
    const body = parseJsonBody<{ dueAt?: unknown }>(init);
    let nextDue: string | null;
    if (body.dueAt === null || body.dueAt === "") {
      nextDue = null;
    } else if (typeof body.dueAt === "string") {
      const parsed = new Date(body.dueAt);
      if (Number.isNaN(parsed.getTime())) throw new ApiError("Invalid due date.", 400);
      nextDue = parsed.toISOString();
    } else {
      throw new ApiError("Invalid due date.", 400);
    }
    const prev = req.due_at;
    req.due_at = nextDue;
    logAudit(req, "operator", "request.due_date_updated", {
      from: prev,
      to: nextDue,
      by: state.user.email,
    });
    return { ok: true, due_at: nextDue } as T;
  }

  const toggleRemMatch = pathname.match(/^\/api\/requests\/([^/]+)\/toggle-reminders$/);
  if (method === "POST" && toggleRemMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(toggleRemMatch[1]));
    if (!req) throw new ApiError("Not found", 404);
    req.reminders_paused = !req.reminders_paused;
    logAudit(req, "operator", req.reminders_paused ? "reminders.paused" : "reminders.resumed", {});
    return { ok: true, reminders_paused: req.reminders_paused } as T;
  }

  const remindNowMatch = pathname.match(/^\/api\/requests\/([^/]+)\/remind-now$/);
  if (method === "POST" && remindNowMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(remindNowMatch[1]));
    if (!req) throw new ApiError("Not found", 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      throw new ApiError("Checklist is closed.", 409);
    }
    const outstanding = req.items.filter(
      (i) => (i.required || i.status === "rejected") && (i.status === "pending" || i.status === "rejected")
    );
    if (outstanding.length === 0) {
      throw new ApiError("No outstanding items to remind the client about.", 400);
    }
    if (req.last_manual_reminder_at) {
      const elapsed = Date.now() - Date.parse(req.last_manual_reminder_at);
      if (elapsed >= 0 && elapsed < MANUAL_COOLDOWN_MS) {
        throw new ApiError("Reminder sent recently. Please wait before sending another.", 429);
      }
    }
    const nowIso = new Date().toISOString();
    req.reminders_sent += 1;
    req.last_manual_reminder_at = nowIso;
    req.next_reminder_at =
      req.reminders_sent < req.max_reminders && req.reminder_interval_days > 0
        ? addDaysIso(nowIso, req.reminder_interval_days)
        : null;
    const outboxUrl = outboxPortalUrl(req.magicToken);
    addOutboxEmail({
      requestId: req.id,
      recipient: req.client_email,
      subject: `Reminder: ${outstanding.length} item${outstanding.length === 1 ? "" : "s"} left for ${req.title}`,
      textBody: [
        `Hi ${req.client_name},`,
        "",
        `A quick reminder from ${state.workspace.name}. Still needed for "${req.title}":`,
        "",
        ...outstanding.map((i) => `  - ${i.label}`),
        "",
        "Open your secure checklist:",
        outboxUrl,
      ].join("\n"),
      htmlBody: renderEmailHtml({
        brandName: state.workspace.name,
        accentColor: state.workspace.brand_color || "#0F5243",
        heading: `${outstanding.length} item${outstanding.length === 1 ? "" : "s"} left`,
        bodyHtml: `<p>Hi ${escapeHtml(req.client_name)}, a quick reminder from ${escapeHtml(state.workspace.name)}.</p><ul>${outstanding.map((i) => `<li>${escapeHtml(i.label)}</li>`).join("")}</ul>`,
        cta: { label: "Continue checklist", url: outboxUrl },
      }),
      kind: "reminder",
      isDemo: req.is_demo,
    });
    logAudit(req, "operator", "reminder.manual_sent", {
      by: state.user.email,
      outstandingCount: outstanding.length,
      reminderNumber: req.reminders_sent,
    });
    return {
      ok: true,
      reminders_sent: req.reminders_sent,
      last_manual_reminder_at: req.last_manual_reminder_at,
      next_reminder_at: req.next_reminder_at,
    } as T;
  }

  const addItemMatch = pathname.match(/^\/api\/requests\/([^/]+)\/items$/);
  if (method === "POST" && addItemMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(addItemMatch[1]));
    if (!req) throw new ApiError("Not found", 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      throw new ApiError("Checklist is closed.", 409);
    }
    const spec = normalizeTemplateItems([parseJsonBody(init)])[0];
    const nowIso = new Date().toISOString();
    const pos = req.items.length > 0 ? Math.max(...req.items.map((i) => i.position)) + 1 : 0;
    const newItem: DemoItemRecord = {
      id: nextId("itm"),
      position: pos,
      section: spec.section || "General",
      label: spec.label,
      help_text: spec.helpText || "",
      kind: spec.kind,
      required: spec.required,
      validator: spec.validator || "none",
      config: {
        allowedGroups: spec.allowedGroups,
        maxFileMb: spec.maxFileMb ?? 20,
        multiple: Boolean(spec.multiple),
        slug: spec.slug || slugify(spec.label, `item-${pos + 1}`),
      },
      status: "pending",
      rawValue: null,
      review_note: null,
      client_note: null,
      client_na: false,
      updated_at: nowIso,
      uploads: [],
    };
    req.items.push(newItem);
    logAudit(req, "operator", "item.added", {
      itemId: newItem.id,
      label: newItem.label,
      kind: newItem.kind,
      required: newItem.required,
    });
    recomputeRequestStatus(req, nowIso);
    return {
      ok: true,
      requestStatus: req.status,
      item: formatItemForOperator(newItem),
    } as T;
  }

  const revealMatch = pathname.match(/^\/api\/requests\/([^/]+)\/items\/([^/]+)\/reveal$/);
  if (method === "POST" && revealMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(revealMatch[1]));
    const item = req?.items.find((i) => i.id === decodeURIComponent(revealMatch[2]));
    if (!req || !item) throw new ApiError("Not found", 404);
    if (item.rawValue === null) throw new ApiError("No value stored", 404);
    logAudit(req, "operator", "item.sensitive_revealed", {
      itemId: item.id,
      by: state.user.email,
    });
    return { itemId: item.id, value: item.rawValue } as T;
  }

  const reviewMatch = pathname.match(/^\/api\/requests\/([^/]+)\/items\/([^/]+)\/review$/);
  if (method === "POST" && reviewMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(reviewMatch[1]));
    const item = req?.items.find((i) => i.id === decodeURIComponent(reviewMatch[2]));
    if (!req || !item) throw new ApiError("Not found", 404);
    if (req.status === "purged" || req.status === "expired") {
      throw new ApiError("Checklist is closed.", 409);
    }
    const body = parseJsonBody<{ decision?: unknown; note?: string }>(init);
    if (body.decision !== "approved" && body.decision !== "rejected") {
      throw new ApiError("Decision must be 'approved' or 'rejected'.", 400);
    }
    const decision = body.decision;
    if (decision === "approved" && item.status === "pending") {
      throw new ApiError("Cannot approve an item that has not been submitted.", 409);
    }
    const note = String(body.note || "").trim();
    const prevStatus = req.status;
    const nowIso = new Date().toISOString();

    item.status = decision;
    if (decision === "rejected" && item.kind === "checkbox") {
      item.rawValue = null;
      item.review_note = note || "Please review and confirm.";
    } else {
      item.review_note = decision === "rejected" ? note || "Please review and re-upload." : null;
    }
    item.updated_at = nowIso;
    logAudit(req, "operator", `item.${decision}`, {
      itemId: item.id,
      note: decision === "rejected" ? note : undefined,
    });
    recomputeRequestStatus(req, nowIso);

    if (decision === "rejected") {
      const outboxUrl = outboxPortalUrl(req.magicToken);
      addOutboxEmail({
        requestId: req.id,
        recipient: req.client_email,
        subject: `One item needs another look: ${item.label}`,
        textBody: [
          `Hi ${req.client_name},`,
          "",
          `${state.workspace.name} reviewed "${item.label}" on "${req.title}" and asked for an update:`,
          "",
          item.review_note || "",
          "",
          "Open your checklist to update this item:",
          outboxUrl,
        ].join("\n"),
        htmlBody: renderEmailHtml({
          brandName: state.workspace.name,
          accentColor: state.workspace.brand_color || "#0F5243",
          heading: "One item needs another look",
          bodyHtml: `<p>Hi ${escapeHtml(req.client_name)},</p><p>${escapeHtml(state.workspace.name)} reviewed <strong>${escapeHtml(item.label)}</strong> and asked for an update:</p><p style="padding:10px 12px;background:#FFF8EB;border:1px solid #F5D9A8;border-radius:8px;">${escapeHtml(item.review_note || "")}</p>`,
          cta: { label: "Update item", url: outboxUrl },
        }),
        kind: "revision",
        isDemo: req.is_demo,
      });
    }

    return {
      ok: true,
      status: req.status,
      justCompleted: prevStatus !== "completed" && req.status === "completed",
    } as T;
  }

  const approveAllMatch = pathname.match(/^\/api\/requests\/([^/]+)\/approve-all-submitted$/);
  if (method === "POST" && approveAllMatch) {
    const req = state.requests.find((r) => r.id === decodeURIComponent(approveAllMatch[1]));
    if (!req) throw new ApiError("Not found", 404);
    const prevStatus = req.status;
    const nowIso = new Date().toISOString();
    let approvedCount = 0;
    for (const item of req.items) {
      if (item.status === "submitted") {
        item.status = "approved";
        item.review_note = null;
        item.updated_at = nowIso;
        approvedCount += 1;
      }
    }
    if (approvedCount > 0) {
      logAudit(req, "operator", "request.approved_all_submitted", { count: approvedCount });
    }
    recomputeRequestStatus(req, nowIso);
    return {
      ok: true,
      approvedCount,
      status: req.status,
      justCompleted: prevStatus !== "completed" && req.status === "completed",
    } as T;
  }

  if (method === "GET" && pathname === "/api/clients") {
    const byEmail = new Map<string, ClientSummaryDto>();
    const sortedReqs = [...state.requests].sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const r of sortedReqs) {
      const email = r.client_email.trim().toLowerCase();
      const activity = r.last_opened_at && r.last_opened_at > r.created_at ? r.last_opened_at : r.created_at;
      const isActive = r.status === "open" || r.status === "in_review";
      const submitted = r.items.filter((i) => i.status === "submitted").length;
      const brief: ClientRequestBriefDto = {
        id: r.id,
        title: r.title,
        status: r.status,
        due_at: r.due_at,
        created_at: r.created_at,
        total_items: r.items.length,
        approved_items: r.items.filter((i) => i.status === "approved").length,
        submitted_items: submitted,
        rejected_items: r.items.filter((i) => i.status === "rejected").length,
      };
      const existing = byEmail.get(email);
      if (!existing) {
        byEmail.set(email, {
          email,
          name: r.client_name,
          totalRequests: 1,
          activeRequests: isActive ? 1 : 0,
          awaitingReviewRequests: isActive && submitted > 0 ? 1 : 0,
          completedRequests: r.status === "completed" ? 1 : 0,
          lastActivityAt: activity,
          requests: [brief],
        });
      } else {
        existing.totalRequests += 1;
        if (isActive) existing.activeRequests += 1;
        if (isActive && submitted > 0) existing.awaitingReviewRequests += 1;
        if (r.status === "completed") existing.completedRequests += 1;
        if (activity > existing.lastActivityAt) existing.lastActivityAt = activity;
        existing.requests.push(brief);
      }
    }
    const clients = Array.from(byEmail.values()).sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt)
    );
    return { clients } as T;
  }

  if (method === "GET" && pathname === "/api/templates") {
    const sorted = [...state.templates].sort((a, b) => {
      if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
      return b.created_at.localeCompare(a.created_at);
    });
    return {
      templates: sorted.map((t) => ({ ...t, items: t.items.map((i) => ({ ...i })) })),
      branding: getBranding(),
    } as T;
  }

  if (method === "POST" && pathname === "/api/templates") {
    const body = parseJsonBody<{ name?: string; description?: string; items?: unknown }>(init);
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    if (!name) throw new ApiError("Template name is required.", 400);
    const items = normalizeTemplateItems(body.items);
    const created: TemplateDto = {
      id: nextId("tpl"),
      name,
      description,
      is_builtin: false,
      items,
      created_at: new Date().toISOString(),
    };
    state.templates.push(created);
    return { template: created } as T;
  }

  const tplDupMatch = pathname.match(/^\/api\/templates\/([^/]+)\/duplicate$/);
  if (method === "POST" && tplDupMatch) {
    const source = state.templates.find((t) => t.id === decodeURIComponent(tplDupMatch[1]));
    if (!source) throw new ApiError("Template not found", 404);
    const body = parseJsonBody<{ name?: string }>(init);
    const copy: TemplateDto = {
      id: nextId("tpl"),
      name: body.name?.trim() || `${source.name} (Copy)`,
      description: source.description,
      is_builtin: false,
      items: source.items.map((i) => ({ ...i })),
      created_at: new Date().toISOString(),
    };
    state.templates.push(copy);
    return { template: copy } as T;
  }

  const tplMatch = pathname.match(/^\/api\/templates\/([^/]+)$/);
  if (method === "PUT" && tplMatch) {
    const target = state.templates.find((t) => t.id === decodeURIComponent(tplMatch[1]));
    if (!target) throw new ApiError("Template not found", 404);
    const body = parseJsonBody<{ name?: string; description?: string; items?: unknown }>(init);
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    if (!name) throw new ApiError("Template name is required.", 400);
    target.name = name;
    target.description = description;
    target.items = normalizeTemplateItems(body.items);
    return { template: { ...target, items: target.items.map((i) => ({ ...i })) } } as T;
  }

  if (method === "DELETE" && tplMatch) {
    const targetId = decodeURIComponent(tplMatch[1]);
    const target = state.templates.find((t) => t.id === targetId);
    if (!target) throw new ApiError("Template not found", 404);
    if (target.is_builtin) throw new ApiError("Built-in starter packs cannot be deleted", 400);
    state.templates = state.templates.filter((t) => t.id !== targetId);
    return { ok: true } as T;
  }

  if (method === "GET" && pathname === "/api/validators") {
    return {
      validators: VALIDATOR_OPTIONS.filter((v) => v.value !== "none").map((v) => ({
        key: v.value,
        label: v.label,
        short: v.short,
        hint: v.hint,
        sensitive: Boolean(v.sensitive),
      })),
    } as T;
  }

  if (method === "GET" && pathname === "/api/settings") {
    return buildSettingsResponse() as T;
  }

  if (method === "PUT" && pathname === "/api/settings/branding") {
    const body = parseJsonBody<{
      brandColor?: string | null;
      supportEmail?: string | null;
      supportPhone?: string | null;
      logoDataUrl?: string | null;
    }>(init);
    const brandColor = body.brandColor ? String(body.brandColor).trim() : null;
    if (brandColor && !/^#[0-9a-fA-F]{6}$/.test(brandColor)) {
      throw new ApiError("Brand colour must be a hex value like #0F5243.", 400);
    }
    const supportEmail = body.supportEmail ? String(body.supportEmail).trim().slice(0, 200) : null;
    if (supportEmail && !validateTextValue("email", supportEmail).valid) {
      throw new ApiError("Support email is not a valid email address.", 400);
    }
    const supportPhone = body.supportPhone ? String(body.supportPhone).trim().slice(0, 40) : null;
    if (supportPhone && !/^[+\d][\d\s()-]{5,}$/.test(supportPhone)) {
      throw new ApiError("Support phone may only contain digits, spaces, +, ( ) and -.", 400);
    }
    if (body.logoDataUrl === null) {
      state.logoDataUrl = null;
      state.workspace.has_logo = false;
    } else if (typeof body.logoDataUrl === "string") {
      const m = body.logoDataUrl.match(SAFE_LOGO_DATA_URL_RE);
      if (!m) throw new ApiError("Logo must be a PNG, JPEG or WebP data URL.", 400);
      const bytes = base64ToBytes(m[2]);
      if (bytes.byteLength > MAX_LOGO_BYTES) {
        throw new ApiError("Logo must be 200 KB or smaller.", 400);
      }
      const detected = detectFileBytes(bytes, "logo");
      if (!detected || !["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) {
        throw new ApiError("Logo must be a PNG, JPEG or WebP image.", 400);
      }
      state.logoDataUrl = `data:${detected.mime};base64,${m[2]}`;
      state.workspace.has_logo = true;
    }
    state.workspace.brand_color = brandColor;
    state.workspace.support_email = supportEmail;
    state.workspace.support_phone = supportPhone;
    return { ok: true, branding: getBranding() } as T;
  }

  if (method === "PUT" && pathname === "/api/settings/webhook") {
    const body = parseJsonBody<{ webhookUrl?: string; webhookSecret?: string }>(init);
    const webhookUrl = String(body.webhookUrl || "").trim();
    const webhookSecret = String(body.webhookSecret || "").trim();
    if (webhookUrl) {
      try {
        const parsed = new URL(webhookUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("Invalid protocol");
        }
      } catch {
        throw new ApiError("Webhook URL must be valid http or https.", 400);
      }
    }
    state.workspace.webhook_url = webhookUrl || null;
    state.webhookSecret = webhookSecret;
    state.workspace.has_webhook_secret = Boolean(webhookSecret);
    return { ok: true } as T;
  }

  if (method === "POST" && pathname === "/api/settings/webhook/test") {
    if (!state.workspace.webhook_url) {
      throw new ApiError("Configure a webhook URL first.", 400);
    }
    const nowIso = new Date().toISOString();
    state.webhookDeliveries.unshift({
      id: nextId("whd"),
      request_id: null,
      event: "webhook.test",
      target_url: state.workspace.webhook_url,
      status: "delivered",
      attempts: 1,
      max_attempts: 6,
      last_status_code: 200,
      last_error: null,
      next_attempt_at: null,
      delivered_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return { ok: true, status: 200 } as T;
  }

  if (method === "GET" && pathname === "/api/settings/webhook/deliveries") {
    const queryStr = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const params = new URLSearchParams(queryStr);
    const statusFilter = params.get("status");
    const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 50) || 50));
    const offset = Math.max(0, Number(params.get("offset") || 0) || 0);
    const filtered =
      statusFilter && statusFilter !== "all"
        ? state.webhookDeliveries.filter((d) => d.status === statusFilter)
        : state.webhookDeliveries;
    const page = filtered.slice(offset, offset + limit).map((d) => ({ ...d }));
    return {
      deliveries: page,
      total: filtered.length,
      deadLetterCount: state.webhookDeliveries.filter((d) => d.status === "dead_letter").length,
      hasMore: offset + page.length < filtered.length,
    } as T;
  }

  const whReplayMatch = pathname.match(/^\/api\/settings\/webhook\/deliveries\/([^/]+)\/replay$/);
  if (method === "POST" && whReplayMatch) {
    const target = state.webhookDeliveries.find((d) => d.id === decodeURIComponent(whReplayMatch[1]));
    if (!target) throw new ApiError("Webhook delivery not found.", 404);
    if (!state.workspace.webhook_url) {
      throw new ApiError("Configure a webhook URL before replaying deliveries.", 400);
    }
    const nowIso = new Date().toISOString();
    target.status = "delivered";
    target.attempts += 1;
    target.last_status_code = 200;
    target.last_error = null;
    target.next_attempt_at = null;
    target.delivered_at = nowIso;
    target.updated_at = nowIso;
    return { ok: true, status: 200, delivery: { ...target } } as T;
  }

  if (method === "GET" && pathname === "/api/api-keys") {
    return { apiKeys: state.apiKeys.map((k) => ({ ...k, scopes: [...k.scopes] })) } as T;
  }

  if (method === "POST" && pathname === "/api/api-keys") {
    const body = parseJsonBody<{ name?: string; scopes?: unknown; expiresInDays?: number | null }>(init);
    const name = String(body.name || "").trim();
    if (!name || name.length > 80) throw new ApiError("Enter a key name between 1 and 80 characters.", 400);
    const allowed = new Set<ApiKeyScope>(["requests:read", "requests:write", "templates:read", "mcp:read"]);
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      throw new ApiError("Select at least one API key scope.", 400);
    }
    const scopes: ApiKeyScope[] = [];
    for (const s of body.scopes) {
      if (typeof s !== "string" || !allowed.has(s as ApiKeyScope)) {
        throw new ApiError(`Unknown API key scope: ${String(s)}`, 400);
      }
      if (!scopes.includes(s as ApiKeyScope)) scopes.push(s as ApiKeyScope);
    }
    const nowIso = new Date().toISOString();
    const secret = `gg_live_demo_${syntheticSha256(`${name}:${nowIso}:${state.seq++}`).slice(0, 24)}`;
    const created: ApiKeyDto = {
      id: nextId("key"),
      name,
      key_prefix: secret.slice(0, 16),
      scopes,
      last_used_at: null,
      expires_at:
        typeof body.expiresInDays === "number" && body.expiresInDays > 0
          ? addDaysIso(nowIso, body.expiresInDays)
          : null,
      revoked_at: null,
      created_at: nowIso,
    };
    state.apiKeys.unshift(created);
    return { apiKey: { ...created, scopes: [...created.scopes] }, secret } as T;
  }

  const apiKeyMatch = pathname.match(/^\/api\/api-keys\/([^/]+)$/);
  if (method === "DELETE" && apiKeyMatch) {
    const target = state.apiKeys.find((k) => k.id === decodeURIComponent(apiKeyMatch[1]));
    if (!target) throw new ApiError("API key not found.", 404);
    if (!target.revoked_at) target.revoked_at = new Date().toISOString();
    return { ok: true, apiKey: { ...target, scopes: [...target.scopes] } } as T;
  }

  if (method === "PUT" && pathname === "/api/settings/email") {
    const body = parseJsonBody<{
      backend?: string;
      from?: string;
      replyTo?: string;
      smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string; clearPass?: boolean };
      resend?: { apiKey?: string };
    }>(init);
    const backend = body.backend;
    if (backend !== "console" && backend !== "smtp" && backend !== "resend") {
      throw new ApiError("Choose console, smtp, or resend for email delivery.", 400);
    }
    const from = String(body.from || "").trim();
    const replyTo = String(body.replyTo || "").trim();
    if (/[\r\n]/.test(from) || /[\r\n]/.test(replyTo)) {
      throw new ApiError("Email headers cannot contain line breaks.", 400);
    }
    const fromAddr = from.replace(/^[^<>]*<([^<>]+)>$/, "$1").trim();
    if (backend !== "console" && (!from || !validateTextValue("email", fromAddr).valid)) {
      throw new ApiError("Enter a valid sender email (e.g. Practice <hello@domain.com>).", 400);
    }
    if (backend === "console" && from && !validateTextValue("email", fromAddr).valid) {
      throw new ApiError("Sender email format is invalid.", 400);
    }
    if (replyTo && !validateTextValue("email", replyTo.replace(/^[^<>]*<([^<>]+)>$/, "$1").trim()).valid) {
      throw new ApiError("Reply-to address is invalid.", 400);
    }
    if (backend === "smtp") {
      const host = String(body.smtp?.host || "").trim();
      const port = Number(body.smtp?.port ?? 587);
      const user = String(body.smtp?.user || "").trim();
      if (!host || /\s/.test(host)) throw new ApiError("Enter a valid SMTP host.", 400);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ApiError("SMTP port must be between 1 and 65535.", 400);
      }
      const sameIdentity =
        state.email.smtp.host === host &&
        state.email.smtp.port === port &&
        state.email.smtp.user === user;
      const clearPass = body.smtp?.clearPass === true;
      state.email.smtp = {
        host,
        port,
        secure: Boolean(body.smtp?.secure),
        user,
        hasPass: clearPass
          ? false
          : Boolean(body.smtp?.pass) || (sameIdentity && state.email.smtp.hasPass),
      };
    } else if (backend === "resend") {
      const apiKey = String(body.resend?.apiKey || "").trim();
      if (!apiKey && !state.email.resend.hasApiKey) {
        throw new ApiError("Resend API key is required.", 400);
      }
      state.email.resend = { hasApiKey: true };
    }
    state.email.source = "workspace";
    state.email.backend = backend;
    state.email.from = from || "Harbour Advisory <noreply@harbouradvisory.example.com.au>";
    state.email.replyTo = replyTo;
    return { ok: true, email: { ...state.email } } as T;
  }

  if (method === "POST" && pathname === "/api/settings/email/test") {
    const body = parseJsonBody<{ to?: string }>(init);
    const to = String(body.to || state.user.email).trim();
    if (!to || !validateTextValue("email", to).valid) {
      throw new ApiError("Enter a valid recipient email.", 400);
    }
    addOutboxEmail({
      requestId: null,
      recipient: to,
      subject: `${state.workspace.name} test email`,
      textBody: `This is a test email from ${state.workspace.name} via GatherGate (Local Outbox).`,
      htmlBody: renderEmailHtml({
        brandName: state.workspace.name,
        accentColor: state.workspace.brand_color || "#0F5243",
        heading: "Outbound email is connected",
        bodyHtml: `<p>This is a test message sent from <strong>${escapeHtml(state.workspace.name)}</strong> using <strong>Local Outbox</strong>.</p>`,
      }),
      kind: "test",
      isDemo: false,
    });
    return { ok: true, backend: state.email.backend, to } as T;
  }

  if (method === "PUT" && pathname === "/api/account") {
    const body = parseJsonBody<{ workspaceName?: string; displayName?: string; email?: string }>(init);
    if (body.workspaceName !== undefined) {
      const nextWs = String(body.workspaceName || "").trim();
      if (!nextWs || nextWs.length > 100) {
        throw new ApiError("Practice name must be between 1 and 100 characters.", 400);
      }
      state.workspace.name = nextWs;
    }
    if (body.displayName !== undefined) {
      const nextName = String(body.displayName || "").trim();
      if (nextName.length > 100) throw new ApiError("Display name cannot exceed 100 characters.", 400);
      state.user.displayName = nextName;
    }
    if (body.email !== undefined) {
      const nextEmail = String(body.email || "").trim().toLowerCase();
      if (!validateTextValue("email", nextEmail).valid) {
        throw new ApiError("Enter a valid email address.", 400);
      }
      state.user.email = nextEmail;
    }
    return {
      ok: true,
      user: { ...state.user },
      workspace: { ...state.workspace },
    } as T;
  }

  if (method === "PUT" && pathname === "/api/account/password") {
    const body = parseJsonBody<{ currentPassword?: string; newPassword?: string }>(init);
    if (!String(body.currentPassword || "")) {
      throw new ApiError("Current password is incorrect.", 400);
    }
    if (String(body.newPassword || "").length < 10) {
      throw new ApiError("New password must be at least 10 characters.", 400);
    }
    return { ok: true } as T;
  }

  if (method === "GET" && pathname === "/api/outbox") {
    return {
      emailBackend: state.email.backend,
      emails: state.outbox.map((e) => ({ ...e })),
    } as T;
  }

  if (method === "POST" && pathname === "/api/demo/seed") {
    if (state.requests.some((r) => r.is_demo)) {
      return { ok: true, seeded: false } as T;
    }
    const { requests, outbox } = makeSeedRequestsAndOutbox(Date.now(), state.templates, state.blobs);
    state.requests.push(...requests);
    state.outbox.push(...outbox);
    state.outbox.sort((a, b) => b.created_at.localeCompare(a.created_at));
    state.otpVerifiedRequestIds.delete("req_demo_tax");
    return { ok: true, seeded: true } as T;
  }

  if (method === "POST" && pathname === "/api/demo/clear") {
    let deletedFiles = 0;
    const deletedRequests = state.requests.filter((r) => r.is_demo).length;
    for (const r of state.requests) {
      if (!r.is_demo) continue;
      for (const item of r.items) {
        for (const u of item.uploads) {
          state.blobs.delete(u.id);
          uploadedBlobData.delete(u.id);
          deletedFiles += 1;
        }
      }
    }
    state.requests = state.requests.filter((r) => !r.is_demo);
    state.outbox = state.outbox.filter((e) => e.is_demo !== 1);
    return { ok: true, deletedRequests, deletedFiles } as T;
  }

  throw new ApiError("Not found", 404);
}

export async function demoApiUpload<T>(url: string, formData: FormData): Promise<T> {
  const [pathname] = url.split("?");
  const match = pathname.match(/^\/api\/client\/([^/]+)\/items\/([^/]+)$/);
  if (!match) throw new ApiError("Not found", 404);

  const req = findRequestByToken(decodeURIComponent(match[1]));
  const itemId = decodeURIComponent(match[2]);
  if (!req || req.status === "purged" || req.status === "completed" || req.status === "expired") {
    throw new ApiError("Checklist is closed.", 403);
  }
  if (!isClientVerified(req)) {
    throw new ApiError("Email verification required.", 401);
  }
  const item = req.items.find((i) => i.id === itemId);
  if (!item) throw new ApiError("Item not found", 404);
  if (item.status === "approved") {
    throw new ApiError("Approved items are locked and cannot be modified.", 409);
  }

  const rawFiles = formData
    .getAll("file")
    .filter((v): v is File => typeof v !== "string" && v.size > 0);
  if (rawFiles.length === 0) {
    throw new ApiError("Please choose at least one file to upload.", 400);
  }
  if (!item.config.multiple && rawFiles.length > 1) {
    throw new ApiError("This item only accepts one file at a time.", 400);
  }
  if (rawFiles.length > MAX_FILES_PER_UPLOAD) {
    throw new ApiError(`Upload up to ${MAX_FILES_PER_UPLOAD} files at a time.`, 400);
  }

  const maxMb = Math.min(MAX_ITEM_FILE_MB, Math.max(1, item.config.maxFileMb ?? 20));
  const maxBytes = maxMb * 1024 * 1024;
  const allowedMimes = resolveAllowedMimes(item.config.allowedGroups);
  const currentStorage = getStorageBytes();
  let pendingBytes = 0;
  const prepared: Array<{ name: string; bytes: Uint8Array; detected: { mime: string; ext: string } }> = [];

  for (const file of rawFiles) {
    if (file.size > maxBytes) {
      throw new ApiError(`"${file.name}" exceeds max size of ${maxMb} MB.`, 400);
    }
    if (currentStorage + pendingBytes + file.size > MAX_DEMO_STORAGE_BYTES) {
      throw new ApiError("Demo browser storage limit (50 MB) reached. Remove files or reset the demo.", 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ApiError(`"${file.name}" exceeds max size of ${maxMb} MB.`, 400);
    }
    if (currentStorage + pendingBytes + bytes.byteLength > MAX_DEMO_STORAGE_BYTES) {
      throw new ApiError("Demo browser storage limit (50 MB) reached. Remove files or reset the demo.", 400);
    }
    const detected = detectFileBytes(bytes, file.name);
    if (!detected || !allowedMimes.includes(detected.mime)) {
      throw new ApiError(
        `"${file.name}" failed file-type verification. Upload an allowed PDF, image, spreadsheet, or document.`,
        400
      );
    }
    pendingBytes += bytes.byteLength;
    prepared.push({ name: file.name, bytes, detected });
  }

  const nowIso = new Date().toISOString();
  const savedUploads: UploadDto[] = [];

  for (const pf of prepared) {
    const seq = item.uploads.length + 1;
    const canonicalName = `${slugify(req.client_name, "client")}_${slugify(
      item.config.slug || item.label,
      "doc"
    )}_${String(seq).padStart(2, "0")}.${pf.detected.ext}`;
    const uploadId = nextId("upl");
    const blob = new Blob([pf.bytes.buffer as ArrayBuffer], { type: pf.detected.mime });
    state.blobs.set(uploadId, blob);
    if (pf.bytes.byteLength <= 256 * 1024) {
      uploadedBlobData.set(uploadId, { type: pf.detected.mime, b64: bytesToBase64(pf.bytes) });
    }

    const uploadRow: UploadDto = {
      id: uploadId,
      original_name: pf.name.slice(0, 200),
      canonical_name: canonicalName,
      detected_mime: pf.detected.mime,
      size_bytes: blob.size,
      sha256: syntheticSha256(uploadId),
      created_at: nowIso,
    };
    item.uploads.push(uploadRow);
    savedUploads.push({ ...uploadRow });
  }

  item.status = "submitted";
  item.review_note = null;
  item.client_na = false;
  item.updated_at = nowIso;
  recomputeRequestStatus(req, nowIso);
  logAudit(req, "client", "item.files_uploaded", { itemId: item.id, count: rawFiles.length });
  persistDemoState();

  return {
    ok: true,
    requestStatus: req.status,
    uploads: savedUploads,
  } as T;
}

export async function demoApiBlob(url: string): Promise<Blob> {
  const [pathname] = url.split("?");
  const match = pathname.match(/^\/api\/uploads\/([^/]+)\/(preview|download)$/);
  if (!match) throw new ApiError("Preview not found", 404);
  requireOperator();
  const uploadId = decodeURIComponent(match[1]);
  const blob = state.blobs.get(uploadId);
  if (!blob) throw new ApiError("Preview not found", 404);
  const found = findUpload(uploadId);
  if (found && match[2] === "preview") {
    logAudit(found.request, "operator", "upload.previewed", {
      uploadId: found.upload.id,
      canonicalName: found.upload.canonical_name,
    });
  }
  return blob;
}

export function demoDownloadUpload(uploadId: string): void {
  requireOperator();
  const found = findUpload(uploadId);
  const blob = state.blobs.get(uploadId);
  if (!found || !blob) throw new ApiError("File not found", 404);
  logAudit(found.request, "operator", "upload.downloaded", {
    uploadId: found.upload.id,
    canonicalName: found.upload.canonical_name,
  });
  triggerBrowserDownload(blob, found.upload.canonical_name);
}

export function demoDownloadExport(requestId: string): void {
  requireOperator();
  const req = state.requests.find((r) => r.id === requestId);
  if (!req || req.status === "purged") throw new ApiError("Not found", 404);
  const manifest = {
    request_id: req.id,
    title: req.title,
    client_name: req.client_name,
    client_email: req.client_email,
    status: req.status,
    exported_at: new Date().toISOString(),
    items: req.items.map((it) => ({
      section: it.section,
      label: it.label,
      kind: it.kind,
      validator: it.validator,
      status: it.status,
      value:
        it.rawValue !== null
          ? SENSITIVE_VALIDATORS.has(it.validator)
            ? maskSensitiveValue(it.validator, it.rawValue)
            : it.rawValue
          : null,
      client_na: it.client_na,
      client_note: it.client_note,
      files: it.uploads.map((u) => ({
        canonical_name: u.canonical_name,
        sha256: u.sha256,
        mime: u.detected_mime,
      })),
    })),
  };
  const fileCount = req.items.reduce((acc, it) => acc + it.uploads.length, 0);
  logAudit(req, "operator", "request.exported_zip", { fileCount });
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const filename = `${slugify(req.client_name, "client")}-${slugify(req.title, "pack")}-manifest.json`;
  triggerBrowserDownload(blob, filename);
}
