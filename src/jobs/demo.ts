import type { StorageAdapter } from "../adapters/storage.js";
import { addDaysIso, slugify, type Store } from "../db/queries.js";
import { emailBrand, inviteEmail, reminderEmail, revisionEmail, type RenderedEmail } from "../emails/templates.js";
import { encryptBuffer, encryptField } from "../security/crypto.js";
import type { TemplateItemSpec } from "../templates/presets.js";

function escapePdfText(input: string): string {
  return input
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function createSamplePdf(title: string, lines: string[]): Buffer {
  const ops: string[] = [
    "BT",
    "/F1 16 Tf",
    "54 736 Td",
    `(${escapePdfText(title)}) Tj`,
    "/F1 10 Tf",
    "0 -22 Td",
    "(GatherGate Sample Encrypted Document Fixture - Non-Production) Tj",
    "0 -24 Td",
    "/F1 11 Tf",
  ];

  for (const line of lines) {
    ops.push(`(${escapePdfText(line)}) Tj`);
    ops.push("0 -18 Td");
  }
  ops.push("ET");

  const streamBody = ops.join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamBody, "utf8")} >>\nstream\n${streamBody}\nendstream\nendobj\n`,
  ];

  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let byteOffset = Buffer.byteLength(chunks[0], "utf8");

  for (const obj of objects) {
    offsets.push(byteOffset);
    chunks.push(obj);
    byteOffset += Buffer.byteLength(obj, "utf8");
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

  return Buffer.from(chunks.join(""), "utf8");
}

async function storeDemoUpload(params: {
  store: Store;
  storage: StorageAdapter;
  masterKey: Buffer;
  workspaceId: string;
  requestId: string;
  itemId: string;
  clientName: string;
  itemSlug: string;
  originalName: string;
  pdfTitle: string;
  pdfLines: string[];
}): Promise<void> {
  const buf = createSamplePdf(params.pdfTitle, params.pdfLines);
  const seq = params.store.countUploadsForItem(params.itemId) + 1;
  const canonicalName = `${slugify(params.clientName, "client")}_${slugify(params.itemSlug, "doc")}_${String(seq).padStart(2, "0")}.pdf`;
  const storageKey = `${params.workspaceId}/${params.requestId}/${params.itemId}/${Date.now()}_${canonicalName}.enc`;
  const { ciphertext, meta } = encryptBuffer(params.masterKey, buf, storageKey);
  await params.storage.put(storageKey, ciphertext);

  params.store.addUpload({
    itemId: params.itemId,
    requestId: params.requestId,
    originalName: params.originalName,
    canonicalName,
    detectedMime: "application/pdf",
    sizeBytes: meta.sizeBytes,
    storageKey,
    ivHex: meta.ivHex,
    tagHex: meta.tagHex,
    saltHex: meta.saltHex,
    sha256Hex: meta.sha256Hex,
  });
}

export async function seedDemoWorkspace(params: {
  store: Store;
  storage: StorageAdapter;
  workspaceId: string;
  masterKey: Buffer;
  baseUrl: string;
}): Promise<{ seeded: boolean }> {
  const { store, storage, workspaceId, masterKey, baseUrl } = params;
  if (store.hasDemoData(workspaceId)) {
    return { seeded: false };
  }

  const workspace = store.getWorkspaceById(workspaceId);
  if (!workspace) return { seeded: false };
  const templates = store.listTemplates(workspaceId);
  const eofyTpl = templates.find((t) => t.name.includes("AU Individual Tax Return")) ?? templates[0];
  const basTpl = templates.find((t) => t.name.includes("AU Company / BAS")) ?? templates[0];
  const healthTpl = templates.find((t) => t.name.includes("AU Allied Health")) ?? templates[0];
  const now = new Date();

  // 1. Claire Nguyen - Partial + 1 rejected blurry scan + OTP enabled
  const eofyItems = JSON.parse(eofyTpl.items_json) as TemplateItemSpec[];
  const r1 = store.createRequest({
    workspaceId,
    templateId: eofyTpl.id,
    title: "FY26 Individual Tax Return Pack",
    clientSubject: "Documents for your FY26 tax return",
    welcomeNote: "Please upload your receipts and confirm your bank BSB before Friday.",
    clientName: "Claire Nguyen",
    clientEmail: "claire.nguyen@example.com.au",
    items: eofyItems,
    requireOtp: true,
    reminderIntervalDays: 3,
    maxReminders: 4,
    purgeAfterDays: 30,
    masterKey,
    dueAt: addDaysIso(now.toISOString(), 5),
    lastOpenedAt: new Date(now.getTime() - 2 * 3600_000).toISOString(),
    isDemo: true,
  });

  const r1Items = store.listRequestItems(r1.request.id);
  const r1Tfn = r1Items.find((i) => i.validator === "au_tfn_mod11");
  const r1Bsb = r1Items.find((i) => i.validator === "au_bsb");
  const r1Phone = r1Items.find((i) => i.validator === "au_phone_e164");
  const r1Health = r1Items.find((i) => i.label.includes("Private Health"));
  const r1Receipts = r1Items.find((i) => i.label.includes("Work-Related Expense"));
  const r1Decl = r1Items.find((i) => i.kind === "checkbox");

  if (r1Tfn) {
    store.saveTextOrCheckboxSubmission(r1Tfn.id, r1.request.id, encryptField(masterKey, "876 543 210", r1Tfn.id));
    store.reviewItem({ workspaceId, requestId: r1.request.id, itemId: r1Tfn.id, decision: "approved" });
  }
  if (r1Bsb) {
    store.saveTextOrCheckboxSubmission(r1Bsb.id, r1.request.id, encryptField(masterKey, "062-000", r1Bsb.id));
    store.reviewItem({ workspaceId, requestId: r1.request.id, itemId: r1Bsb.id, decision: "approved" });
  }
  if (r1Phone) {
    store.saveTextOrCheckboxSubmission(r1Phone.id, r1.request.id, encryptField(masterKey, "+61412345678", r1Phone.id));
  }
  if (r1Receipts) {
    await storeDemoUpload({
      store,
      storage,
      masterKey,
      workspaceId,
      requestId: r1.request.id,
      itemId: r1Receipts.id,
      clientName: "Claire Nguyen",
      itemSlug: "deduction-receipts",
      originalName: "FY26-Work-Deductions-Summary.pdf",
      pdfTitle: "Claire Nguyen - FY26 Work Deductions",
      pdfLines: [
        "Taxpayer: Claire Nguyen",
        "Period: 01 Jul 2025 - 30 Jun 2026",
        "Home Office Hours Log: 1,140 hrs (fixed rate)",
        "Professional Membership (CPA): $790.00 AUD",
        "Equipment & Laptop Depreciation: $1,420.00 AUD",
      ],
    });
  }
  if (r1Health) {
    await storeDemoUpload({
      store,
      storage,
      masterKey,
      workspaceId,
      requestId: r1.request.id,
      itemId: r1Health.id,
      clientName: "Claire Nguyen",
      itemSlug: "private-health-statement",
      originalName: "Bupa-Tax-Statement-Page1.pdf",
      pdfTitle: "Private Health Insurance Statement (Page 1 of 2)",
      pdfLines: [
        "Member: Claire Nguyen",
        "Policy Tier: Gold Hospital",
        "Note: Rebate summary table appears on page 2 (omitted in scan).",
      ],
    });
    store.reviewItem({
      workspaceId,
      requestId: r1.request.id,
      itemId: r1Health.id,
      decision: "rejected",
      note: "Uploaded page 1 only. Please include the rebate summary on page 2.",
    });
  }
  if (r1Decl) {
    store.saveTextOrCheckboxSubmission(r1Decl.id, r1.request.id, encryptField(masterKey, "confirmed", r1Decl.id));
    store.reviewItem({ workspaceId, requestId: r1.request.id, itemId: r1Decl.id, decision: "approved" });
  }

  const r1PortalUrl = `${baseUrl}/c/${r1.magicToken}`;
  const brand = emailBrand(workspace, baseUrl);
  const saveDemoEmail = (requestId: string, recipient: string, kind: string, message: RenderedEmail) =>
    store.saveOutboxEmail({
      workspaceId,
      requestId,
      recipient,
      subject: message.subject,
      textBody: message.text,
      htmlBody: message.html,
      kind,
      isDemo: true,
    });
  saveDemoEmail(
    r1.request.id,
    r1.request.client_email,
    "invite",
    inviteEmail({
      brand,
      clientName: "Claire Nguyen",
      title: r1.request.title,
      portalUrl: r1PortalUrl,
      itemCount: r1Items.length,
      welcomeNote: r1.request.welcome_note,
      dueAt: r1.request.due_at,
      subject: r1.request.client_subject,
    })
  );
  saveDemoEmail(
    r1.request.id,
    r1.request.client_email,
    "revision",
    revisionEmail({
      brand,
      clientName: "Claire Nguyen",
      title: r1.request.title,
      itemLabel: "Private Health Insurance Tax Statement",
      note: "Uploaded page 1 only. Please include the rebate summary on page 2.",
      portalUrl: r1PortalUrl,
    })
  );

  // 2. Harbourline Plumbing Pty Ltd - Active BAS pack with chaser sent
  const basItems = JSON.parse(basTpl.items_json) as TemplateItemSpec[];
  const r2 = store.createRequest({
    workspaceId,
    templateId: basTpl.id,
    title: "Q3 BAS & Supplier Pack",
    clientSubject: "Q3 BAS records due in 2 days",
    clientName: "Harbourline Plumbing Pty Ltd",
    clientEmail: "accounts@harbourline.com.au",
    items: basItems,
    requireOtp: false,
    reminderIntervalDays: 3,
    maxReminders: 4,
    purgeAfterDays: 30,
    masterKey,
    dueAt: addDaysIso(now.toISOString(), 2),
    remindersSent: 1,
    lastOpenedAt: new Date(now.getTime() - 26 * 3600_000).toISOString(),
    isDemo: true,
  });

  const r2Items = store.listRequestItems(r2.request.id);
  const r2Abn = r2Items.find((i) => i.validator === "au_abn_mod89");
  const r2Bsb = r2Items.find((i) => i.validator === "au_bsb");
  const r2Stmts = r2Items.find((i) => i.label.includes("Bank Statements"));

  if (r2Abn) {
    store.saveTextOrCheckboxSubmission(r2Abn.id, r2.request.id, encryptField(masterKey, "51 824 753 556", r2Abn.id));
  }
  if (r2Bsb) {
    store.saveTextOrCheckboxSubmission(r2Bsb.id, r2.request.id, encryptField(masterKey, "083-170", r2Bsb.id));
  }
  if (r2Stmts) {
    await storeDemoUpload({
      store,
      storage,
      masterKey,
      workspaceId,
      requestId: r2.request.id,
      itemId: r2Stmts.id,
      clientName: "Harbourline Plumbing Pty Ltd",
      itemSlug: "bank-statements",
      originalName: "NAB-Business-Q3-Statement.pdf",
      pdfTitle: "Harbourline Plumbing Pty Ltd - Q3 Business Statement",
      pdfLines: [
        "ABN: 51 824 753 556 | BSB: 083-170",
        "Opening Balance (01 Jan): $48,210.45 AUD",
        "Closing Balance (31 Mar): $62,940.10 AUD",
        "GST Collected Summary Verified",
      ],
    });
  }

  const r2PortalUrl = `${baseUrl}/c/${r2.magicToken}`;
  const r2Outstanding = store
    .listRequestItems(r2.request.id)
    .filter((i) => i.required === 1 && i.status === "pending")
    .map((i) => ({ label: i.label, needsRevision: false }));
  saveDemoEmail(
    r2.request.id,
    r2.request.client_email,
    "reminder",
    reminderEmail({
      brand,
      clientName: "Harbourline Plumbing Pty Ltd",
      title: r2.request.title,
      portalUrl: r2PortalUrl,
      outstanding: r2Outstanding,
    })
  );

  // 3. Marcus Okafor - Completed Allied Health pack ready for ZIP export
  const healthItems = JSON.parse(healthTpl.items_json) as TemplateItemSpec[];
  const r3 = store.createRequest({
    workspaceId,
    templateId: healthTpl.id,
    title: "Allied Health New Patient Intake",
    clientName: "Marcus Okafor",
    clientEmail: "marcus.okafor@example.com.au",
    items: healthItems,
    requireOtp: false,
    reminderIntervalDays: 3,
    maxReminders: 4,
    purgeAfterDays: 30,
    masterKey,
    lastOpenedAt: new Date(now.getTime() - 48 * 3600_000).toISOString(),
    isDemo: true,
  });

  const r3Items = store.listRequestItems(r3.request.id);
  const r3Med = r3Items.find((i) => i.validator === "au_medicare_mod10");
  const r3Phone = r3Items.find((i) => i.validator === "au_phone_e164");
  const r3Ref = r3Items.find((i) => i.kind === "file");
  const r3Consent = r3Items.find((i) => i.kind === "checkbox");

  if (r3Med) {
    store.saveTextOrCheckboxSubmission(r3Med.id, r3.request.id, encryptField(masterKey, "2123 45670 1 / 1", r3Med.id));
  }
  if (r3Phone) {
    store.saveTextOrCheckboxSubmission(r3Phone.id, r3.request.id, encryptField(masterKey, "+61438901244", r3Phone.id));
  }
  if (r3Ref) {
    await storeDemoUpload({
      store,
      storage,
      masterKey,
      workspaceId,
      requestId: r3.request.id,
      itemId: r3Ref.id,
      clientName: "Marcus Okafor",
      itemSlug: "gp-referral",
      originalName: "GP-EPC-Referral-Marcus-Okafor.pdf",
      pdfTitle: "GP Chronic Disease Management Referral (EPC)",
      pdfLines: [
        "Patient: Marcus Okafor",
        "Medicare Card: 2123 45670 1 / 1",
        "Referring GP: Dr. Priya Sharma (Provider 2426621B)",
        "Approved Sessions: 5 Allied Health Visits",
      ],
    });
  }
  if (r3Consent) {
    store.saveTextOrCheckboxSubmission(r3Consent.id, r3.request.id, encryptField(masterKey, "confirmed", r3Consent.id));
  }
  store.approveAllSubmitted(workspaceId, r3.request.id);

  saveDemoEmail(
    r3.request.id,
    r3.request.client_email,
    "invite",
    inviteEmail({
      brand,
      clientName: "Marcus Okafor",
      title: r3.request.title,
      portalUrl: `${baseUrl}/c/${r3.magicToken}`,
      itemCount: r3Items.length,
    })
  );

  return { seeded: true };
}
