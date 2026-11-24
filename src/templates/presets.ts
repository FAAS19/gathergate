import type { ValidatorKey } from "../validators/index.js";

export type ItemKind = "file" | "text" | "textarea" | "checkbox";

export interface TemplateItemSpec {
  section: string;
  label: string;
  helpText: string;
  kind: ItemKind;
  required: boolean;
  validator: ValidatorKey;
  allowedGroups?: string[];
  maxFileMb?: number;
  multiple?: boolean;
  slug?: string;
}

export interface BuiltinTemplateSpec {
  key: string;
  name: string;
  description: string;
  items: TemplateItemSpec[];
}

export const BUILTIN_TEMPLATES: BuiltinTemplateSpec[] = [
  {
    key: "agency-onboarding",
    name: "Agency / Web Project Client Onboarding",
    description: "Collect brand assets, hosting/domain contacts, company details, and scope sign-off without endless email threads.",
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
    key: "au-individual-tax-eofy",
    name: "AU Individual Tax Return (EOFY Pack)",
    description: "Australian EOFY personal tax checklist with ATO TFN mod-11 masking, BSB verification, and receipt uploads.",
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
    key: "au-bas-bookkeeping",
    name: "AU Company / BAS Bookkeeping Pack",
    description: "Quarterly BAS & supplier invoice intake pack with ATO ABN mod-89 validation and bank/statement uploads.",
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
    key: "au-allied-health-intake",
    name: "AU Allied Health Clinic New Patient Intake",
    description: "Passwordless clinical referral & Medicare intake pack with Services Australia mod-10 + IRN verification.",
    items: [
      {
        section: "Patient Details",
        label: "Medicare Card Number + IRN",
        helpText: "11 digits including 1-digit IRN (verified via Services Australia mod-10 and stored masked).",
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
        helpText: "I consent to the clinic collecting these records for treatment and Medicare claiming.",
        kind: "checkbox",
        required: true,
        validator: "none",
        slug: "clinical-consent",
      },
    ],
  },
];
