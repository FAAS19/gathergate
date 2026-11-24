import type { EmailAdapter } from "../adapters/email.js";
import type { Store } from "../db/queries.js";
import { emailBrand, reminderEmail } from "../emails/templates.js";
import { decryptField } from "../security/crypto.js";

export async function runReminderSweep(params: {
  store: Store;
  email: EmailAdapter;
  baseUrl: string;
  masterKey: Buffer;
  nowIso?: string;
  saveToOutbox?: boolean;
}): Promise<number> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const due = params.store.listDueReminders(nowIso);
  let sentCount = 0;

  for (const req of due) {
    const items = params.store.listRequestItems(req.id);
    const outstanding = items.filter(
      (i) => (i.required === 1 || i.status === "rejected") && (i.status === "pending" || i.status === "rejected")
    );
    if (outstanding.length === 0) continue;
    const workspace = params.store.getWorkspaceById(req.workspace_id);
    if (!workspace) continue;

    const magicToken = decryptField(params.masterKey, req.token_encrypted, req.id);
    const message = reminderEmail({
      brand: emailBrand(workspace, params.baseUrl),
      clientName: req.client_name,
      title: req.title,
      portalUrl: `${params.baseUrl}/c/${magicToken}`,
      outstanding: outstanding.map((i) => ({
        label: i.label,
        needsRevision: i.status === "rejected",
        note: i.review_note,
      })),
    });

    await params.email.send({ to: req.client_email, ...message });
    if (params.saveToOutbox) {
      params.store.saveOutboxEmail({
        workspaceId: req.workspace_id,
        requestId: req.id,
        recipient: req.client_email,
        subject: message.subject,
        textBody: message.text,
        htmlBody: message.html,
        kind: "reminder",
        isDemo: req.is_demo === 1,
      });
    }

    params.store.recordReminderSent(req.id, nowIso);
    sentCount += 1;
  }

  return sentCount;
}
