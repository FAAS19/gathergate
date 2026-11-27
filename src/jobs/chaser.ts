import { createEmailAdapterFromOptions, resolveWorkspaceEmail, type EmailAdapter } from "../adapters/email.js";
import type { AppConfig } from "../config.js";
import type { Store } from "../db/queries.js";
import { emailBrand, reminderEmail } from "../emails/templates.js";
import { decryptField } from "../security/crypto.js";
import { assertPublicHostname, type LookupAllFn } from "../security/ssrf.js";

export async function runReminderSweep(params: {
  store: Store;
  email: EmailAdapter;
  baseUrl: string;
  masterKey: Buffer;
  config?: AppConfig;
  nowIso?: string;
  saveToOutbox?: boolean;
  lookupImpl?: LookupAllFn;
}): Promise<number> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const due = params.store.listDueReminders(nowIso);
  let sentCount = 0;

  for (const req of due) {
    const items = params.store.listRequestItems(req.id);
    const requiredItems = items.filter((i) => i.required === 1);
    const checkSet = new Set((requiredItems.length > 0 ? requiredItems : items).map((i) => i.id));
    const outstanding = items.filter(
      (i) => (checkSet.has(i.id) || i.status === "rejected") && (i.status === "pending" || i.status === "rejected")
    );
    if (outstanding.length === 0) {
      params.store.clearNextReminder(req.id);
      continue;
    }
    const workspace = params.store.getWorkspaceById(req.workspace_id);
    if (!workspace) continue;

    try {
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

      const resolved = params.config
        ? resolveWorkspaceEmail(workspace, params.config, params.masterKey)
        : null;
      if (
        params.config?.multiTenant &&
        resolved &&
        resolved.source === "workspace" &&
        resolved.backend === "smtp" &&
        resolved.smtp?.host
      ) {
        const dnsErr = await assertPublicHostname(resolved.smtp.host, params.lookupImpl);
        if (dnsErr) {
          throw new Error("SMTP host must resolve to a public address in multi-tenant mode.");
        }
      }
      const adapter =
        resolved && resolved.source === "workspace"
          ? createEmailAdapterFromOptions(resolved)
          : params.email;
      await adapter.send({
        to: req.client_email,
        replyTo: resolved?.replyTo || undefined,
        ...message,
      });
      const shouldSaveOutbox = resolved ? resolved.backend === "console" : Boolean(params.saveToOutbox);
      if (shouldSaveOutbox) {
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
    } catch (err) {
      console.error(`[GatherGate Cron] reminder failed for request ${req.id}:`, err);
      params.store.logAudit(req.workspace_id, req.id, "system", "reminder.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      const retryAt = new Date(Date.parse(nowIso) + 3600_000).toISOString();
      params.store.deferReminderAfterError(req.id, retryAt);
    }
  }

  return sentCount;
}
