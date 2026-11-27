import type { DatabaseSync } from "node:sqlite";
import { encryptField, generateId, generateMagicToken, sha256Hex } from "../security/crypto.js";
import { BUILTIN_TEMPLATES, type ItemKind, type TemplateItemSpec } from "../templates/presets.js";
import type { ValidatorKey } from "../validators/index.js";

export class SetupAlreadyCompletedError extends Error {
  constructor() {
    super("Setup has already been completed.");
  }
}

export class ClientWriteConflictError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 403 | 404 | 409
  ) {
    super(message);
  }
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  max_active_requests: number;
  max_storage_bytes: number;
  webhook_url: string | null;
  webhook_secret: string | null;
  brand_color: string | null;
  logo_mime: string | null;
  logo_b64: string | null;
  support_email: string | null;
  support_phone: string | null;
  email_backend: string | null;
  email_from: string | null;
  email_reply_to: string | null;
  email_config_encrypted: string | null;
  created_at: string;
}

export interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  created_at: string;
}

export interface TemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  is_builtin: number;
  items_json: string;
  created_at: string;
}

export interface RequestRow {
  id: string;
  workspace_id: string;
  template_id: string | null;
  title: string;
  client_name: string;
  client_email: string;
  token_hash: string;
  token_encrypted: string;
  require_otp: number;
  status: "open" | "in_review" | "completed" | "expired" | "purged";
  reminder_interval_days: number;
  max_reminders: number;
  reminders_sent: number;
  reminders_paused: number;
  next_reminder_at: string | null;
  purge_after_days: number;
  purge_at: string | null;
  completed_at: string | null;
  is_demo: number;
  due_at: string | null;
  client_subject: string | null;
  welcome_note: string | null;
  last_opened_at: string | null;
  last_manual_reminder_at: string | null;
  overdue_notified_at: string | null;
  created_at: string;
}

export interface RequestItemRow {
  id: string;
  request_id: string;
  position: number;
  section: string;
  label: string;
  help_text: string;
  kind: ItemKind;
  required: number;
  validator: ValidatorKey;
  config_json: string;
  status: "pending" | "submitted" | "rejected" | "approved";
  value_encrypted: string | null;
  review_note: string | null;
  client_note_encrypted: string | null;
  client_na: number;
  updated_at: string;
}

export interface UploadRow {
  id: string;
  request_item_id: string;
  original_name: string;
  canonical_name: string;
  detected_mime: string;
  size_bytes: number;
  storage_key: string;
  enc_version: string;
  enc_iv: string;
  enc_tag: string;
  enc_salt: string;
  sha256: string;
  created_at: string;
  purged_at: string | null;
}

export interface AuditEventRow {
  id: string;
  workspace_id: string;
  request_id: string | null;
  actor: string;
  action: string;
  meta_json: string;
  created_at: string;
}

export interface OutboxEmailRow {
  id: string;
  workspace_id: string;
  request_id: string | null;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  kind: string;
  is_demo: number;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes_json: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type WebhookDeliveryStatus = "pending" | "in_flight" | "retrying" | "delivered" | "dead_letter";

export interface WebhookDeliveryRow {
  id: string;
  workspace_id: string;
  request_id: string | null;
  event: string;
  target_url: string;
  payload_json: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  max_attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientRequestBrief {
  id: string;
  title: string;
  status: RequestRow["status"];
  due_at: string | null;
  created_at: string;
  total_items: number;
  approved_items: number;
  submitted_items: number;
  rejected_items: number;
}

export interface ClientSummary {
  email: string;
  name: string;
  totalRequests: number;
  activeRequests: number;
  awaitingReviewRequests: number;
  completedRequests: number;
  lastActivityAt: string;
  requests: ClientRequestBrief[];
}

export function slugify(input: string, fallback = "item"): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

export function addDaysIso(fromIso: string, days: number): string {
  const d = new Date(fromIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export class Store {
  private txDepth = 0;

  constructor(private readonly db: DatabaseSync) {}

  private inTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback error if transaction already aborted
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  private assertClientWriteOpenAndUnlocked(requestId: string, itemId: string): RequestItemRow {
    const req = this.db.prepare("SELECT status FROM requests WHERE id = ?").get(requestId) as
      | { status: string }
      | undefined;
    if (!req || req.status === "purged" || req.status === "completed" || req.status === "expired") {
      throw new ClientWriteConflictError("Checklist is closed.", 403);
    }
    const item = this.getRequestItem(requestId, itemId);
    if (!item) {
      throw new ClientWriteConflictError("Item not found", 404);
    }
    if (item.status === "approved") {
      throw new ClientWriteConflictError("Approved items are locked and cannot be modified.", 409);
    }
    return item;
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    return Number(row.c);
  }

  createInitialWorkspaceWithUser(params: {
    workspaceName: string;
    email: string;
    passwordHash: string;
    plan: "self_hosted" | "free" | "pro";
    maxActiveRequests: number;
    maxStorageBytes: number;
  }): { workspace: WorkspaceRow; user: UserRow } {
    return this.inTransaction(() => {
      if (this.countUsers() > 0) {
        throw new SetupAlreadyCompletedError();
      }
      return this.createWorkspaceWithUser(params);
    });
  }

  createWorkspaceWithUser(params: {
    workspaceName: string;
    email: string;
    passwordHash: string;
    plan: "self_hosted" | "free" | "pro";
    maxActiveRequests: number;
    maxStorageBytes: number;
  }): { workspace: WorkspaceRow; user: UserRow } {
    return this.inTransaction(() => {
      const now = new Date().toISOString();
      const wsId = generateId("ws");
      const slug = `${slugify(params.workspaceName, "workspace")}-${wsId.slice(-4).toLowerCase()}`;
      const userId = generateId("usr");

      this.db
        .prepare(
          `INSERT INTO workspaces (id, name, slug, plan, max_active_requests, max_storage_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          wsId,
          params.workspaceName.trim(),
          slug,
          params.plan,
          params.maxActiveRequests,
          params.maxStorageBytes,
          now
        );

      this.db
        .prepare(
          `INSERT INTO users (id, workspace_id, email, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(userId, wsId, params.email.trim().toLowerCase(), params.passwordHash, now);

      this.seedBuiltinTemplates(wsId);

      const workspace = this.getWorkspaceById(wsId)!;
      const user = this.getUserById(userId)!;
      return { workspace, user };
    });
  }

  seedBuiltinTemplates(workspaceId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO templates (id, workspace_id, name, description, is_builtin, items_json, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    );
    for (const tpl of BUILTIN_TEMPLATES) {
      stmt.run(
        generateId("tpl"),
        workspaceId,
        tpl.name,
        tpl.description,
        JSON.stringify(tpl.items),
        now
      );
    }
  }

  getWorkspaceById(id: string): WorkspaceRow | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
  }

  updateWorkspaceWebhook(workspaceId: string, webhookUrl: string | null, webhookSecret: string | null): void {
    this.db
      .prepare("UPDATE workspaces SET webhook_url = ?, webhook_secret = ? WHERE id = ?")
      .run(webhookUrl || null, webhookSecret || null, workspaceId);
  }

  updateWorkspaceName(workspaceId: string, name: string): void {
    this.db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name.trim(), workspaceId);
  }

  updateWorkspaceEmailConfig(
    workspaceId: string,
    params: {
      emailBackend: string | null;
      emailFrom: string | null;
      emailReplyTo: string | null;
      emailConfigEncrypted: string | null;
    }
  ): void {
    this.db
      .prepare(
        "UPDATE workspaces SET email_backend = ?, email_from = ?, email_reply_to = ?, email_config_encrypted = ? WHERE id = ?"
      )
      .run(params.emailBackend, params.emailFrom, params.emailReplyTo, params.emailConfigEncrypted, workspaceId);
  }

  updateUserProfile(userId: string, params: { displayName: string | null; email: string }): void {
    this.db
      .prepare("UPDATE users SET display_name = ?, email = ? WHERE id = ?")
      .run(params.displayName, params.email.trim().toLowerCase(), userId);
  }

  updateUserPassword(userId: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  }

  deleteOtherSessions(userId: string, keepRawToken: string): void {
    this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .run(userId, sha256Hex(keepRawToken));
  }

  updateWorkspaceBranding(
    workspaceId: string,
    branding: {
      brandColor: string | null;
      supportEmail: string | null;
      supportPhone: string | null;
      /** undefined keeps the current logo, null removes it. */
      logo?: { mime: string; b64: string } | null;
    }
  ): void {
    this.db
      .prepare("UPDATE workspaces SET brand_color = ?, support_email = ?, support_phone = ? WHERE id = ?")
      .run(branding.brandColor, branding.supportEmail, branding.supportPhone, workspaceId);
    if (branding.logo !== undefined) {
      this.db
        .prepare("UPDATE workspaces SET logo_mime = ?, logo_b64 = ? WHERE id = ?")
        .run(branding.logo?.mime ?? null, branding.logo?.b64 ?? null, workspaceId);
    }
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email.trim().toLowerCase()) as UserRow | undefined;
  }

  getUserById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  createSession(userId: string, ttlDays = 14): string {
    const rawToken = generateMagicToken();
    const now = new Date().toISOString();
    const expiresAt = addDaysIso(now, ttlDays);
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(generateId("ses"), userId, sha256Hex(rawToken), expiresAt, now);
    return rawToken;
  }

  getUserBySessionToken(rawToken: string): { user: UserRow; workspace: WorkspaceRow } | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT s.user_id FROM sessions s WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(sha256Hex(rawToken), now) as { user_id: string } | undefined;
    if (!row) return null;
    const user = this.getUserById(row.user_id);
    if (!user) return null;
    const workspace = this.getWorkspaceById(user.workspace_id);
    if (!workspace) return null;
    return { user, workspace };
  }

  deleteSessionByToken(rawToken: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(rawToken));
  }

  listTemplates(workspaceId: string): TemplateRow[] {
    return this.db
      .prepare("SELECT * FROM templates WHERE workspace_id = ? ORDER BY is_builtin DESC, created_at DESC")
      .all(workspaceId) as unknown as TemplateRow[];
  }

  getTemplate(workspaceId: string, templateId: string): TemplateRow | undefined {
    return this.db
      .prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ?")
      .get(templateId, workspaceId) as TemplateRow | undefined;
  }

  createTemplate(
    workspaceId: string,
    name: string,
    description: string,
    items: TemplateItemSpec[]
  ): TemplateRow {
    const id = generateId("tpl");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO templates (id, workspace_id, name, description, is_builtin, items_json, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, workspaceId, name.trim(), description.trim(), JSON.stringify(items), now);
    return this.getTemplate(workspaceId, id)!;
  }

  updateTemplate(
    workspaceId: string,
    templateId: string,
    name: string,
    description: string,
    items: TemplateItemSpec[]
  ): TemplateRow | null {
    const existing = this.getTemplate(workspaceId, templateId);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE templates SET name = ?, description = ?, items_json = ? WHERE id = ? AND workspace_id = ?`
      )
      .run(name.trim(), description.trim(), JSON.stringify(items), templateId, workspaceId);
    return this.getTemplate(workspaceId, templateId)!;
  }

  deleteTemplate(workspaceId: string, templateId: string): { deleted: boolean; reason?: string } {
    const existing = this.getTemplate(workspaceId, templateId);
    if (!existing) return { deleted: false, reason: "Template not found" };
    if (existing.is_builtin === 1) {
      return { deleted: false, reason: "Built-in starter packs cannot be deleted" };
    }
    this.db
      .prepare("DELETE FROM templates WHERE id = ? AND workspace_id = ?")
      .run(templateId, workspaceId);
    return { deleted: true };
  }

  duplicateTemplate(workspaceId: string, templateId: string, name?: string): TemplateRow | null {
    const existing = this.getTemplate(workspaceId, templateId);
    if (!existing) return null;
    const id = generateId("tpl");
    const now = new Date().toISOString();
    const copyName = name?.trim() || `${existing.name} (Copy)`;
    this.db
      .prepare(
        `INSERT INTO templates (id, workspace_id, name, description, is_builtin, items_json, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, workspaceId, copyName, existing.description, existing.items_json, now);
    return this.getTemplate(workspaceId, id)!;
  }

  countActiveRequests(workspaceId: string, excludeDemo = false): number {
    const sql = excludeDemo
      ? `SELECT COUNT(*) as c FROM requests WHERE workspace_id = ? AND status IN ('open', 'in_review') AND is_demo = 0`
      : `SELECT COUNT(*) as c FROM requests WHERE workspace_id = ? AND status IN ('open', 'in_review')`;
    const row = this.db.prepare(sql).get(workspaceId) as { c: number };
    return Number(row.c);
  }

  getWorkspaceStorageBytes(workspaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(u.size_bytes), 0) as total
         FROM uploads u
         JOIN request_items ri ON ri.id = u.request_item_id
         JOIN requests r ON r.id = ri.request_id
         WHERE r.workspace_id = ? AND u.purged_at IS NULL`
      )
      .get(workspaceId) as { total: number };
    return Number(row.total);
  }

  createRequest(params: {
    workspaceId: string;
    templateId: string | null;
    title: string;
    clientName: string;
    clientEmail: string;
    items: TemplateItemSpec[];
    requireOtp: boolean;
    reminderIntervalDays: number;
    maxReminders: number;
    purgeAfterDays: number;
    masterKey: Buffer;
    dueAt?: string | null;
    clientSubject?: string | null;
    welcomeNote?: string | null;
    isDemo?: boolean;
    remindersSent?: number;
    lastOpenedAt?: string | null;
    actor?: "operator" | "api_key";
    actorBy?: string;
  }): { request: RequestRow; magicToken: string } {
    return this.inTransaction(() => {
      const id = generateId("req");
      const magicToken = generateMagicToken();
      const now = new Date().toISOString();
      const remindersSent = params.remindersSent ?? 0;
      const nextReminderAt =
        remindersSent < params.maxReminders && params.reminderIntervalDays > 0
          ? addDaysIso(now, params.reminderIntervalDays)
          : null;

      this.db
        .prepare(
          `INSERT INTO requests (
             id, workspace_id, template_id, title, client_name, client_email,
             token_hash, token_encrypted, require_otp, status,
             reminder_interval_days, max_reminders, reminders_sent, reminders_paused,
             next_reminder_at, purge_after_days, is_demo, due_at, client_subject,
             welcome_note, last_opened_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.workspaceId,
          params.templateId,
          params.title.trim(),
          params.clientName.trim(),
          params.clientEmail.trim().toLowerCase(),
          sha256Hex(magicToken),
          encryptField(params.masterKey, magicToken, id),
          params.requireOtp ? 1 : 0,
          params.reminderIntervalDays,
          params.maxReminders,
          remindersSent,
          nextReminderAt,
          params.purgeAfterDays,
          params.isDemo ? 1 : 0,
          params.dueAt || null,
          params.clientSubject?.trim() || null,
          params.welcomeNote?.trim() || null,
          params.lastOpenedAt || null,
          now
        );

      const itemStmt = this.db.prepare(
        `INSERT INTO request_items (
           id, request_id, position, section, label, help_text, kind,
           required, validator, config_json, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      );

      params.items.forEach((item, idx) => {
        itemStmt.run(
          generateId("itm"),
          id,
          idx,
          item.section || "General",
          item.label,
          item.helpText || "",
          item.kind,
          item.required ? 1 : 0,
          item.validator || "none",
          JSON.stringify({
            allowedGroups: item.allowedGroups,
            maxFileMb: item.maxFileMb ?? 20,
            multiple: item.multiple ?? false,
            slug: item.slug || slugify(item.label, `item-${idx + 1}`),
          }),
          now
        );
      });

      this.logAudit(params.workspaceId, id, params.actor ?? "operator", "request.created", {
        clientEmail: params.clientEmail.trim().toLowerCase(),
        itemCount: params.items.length,
        requireOtp: params.requireOtp,
        isDemo: Boolean(params.isDemo),
        ...(params.actorBy ? { by: params.actorBy } : {}),
      });

      return { request: this.getRequestById(params.workspaceId, id)!, magicToken };
    });
  }

  listRequests(
    workspaceId: string
  ): Array<
    RequestRow & {
      total_items: number;
      approved_items: number;
      submitted_items: number;
      rejected_items: number;
    }
  > {
    return this.db
      .prepare(
        `SELECT r.*,
           COUNT(ri.id) as total_items,
           SUM(CASE WHEN ri.status = 'approved' THEN 1 ELSE 0 END) as approved_items,
           SUM(CASE WHEN ri.status = 'submitted' THEN 1 ELSE 0 END) as submitted_items,
           SUM(CASE WHEN ri.status = 'rejected' THEN 1 ELSE 0 END) as rejected_items
         FROM requests r
         LEFT JOIN request_items ri ON ri.request_id = r.id
         WHERE r.workspace_id = ?
         GROUP BY r.id
         ORDER BY r.created_at DESC`
      )
      .all(workspaceId) as unknown as Array<
      RequestRow & {
        total_items: number;
        approved_items: number;
        submitted_items: number;
        rejected_items: number;
      }
    >;
  }

  getRequestById(workspaceId: string, requestId: string): RequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM requests WHERE id = ? AND workspace_id = ?")
      .get(requestId, workspaceId) as RequestRow | undefined;
  }

  getRequestByMagicToken(magicToken: string): RequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM requests WHERE token_hash = ?")
      .get(sha256Hex(magicToken)) as RequestRow | undefined;
  }

  touchRequestOpened(requestId: string): boolean {
    const now = new Date().toISOString();
    const first = this.db
      .prepare("UPDATE requests SET last_opened_at = ? WHERE id = ? AND last_opened_at IS NULL")
      .run(now, requestId);
    if (Number(first.changes ?? 0) > 0) return true;
    this.db.prepare("UPDATE requests SET last_opened_at = ? WHERE id = ?").run(now, requestId);
    return false;
  }

  /** Atomically marks first-open and enqueues the request.opened webhook delivery in one transaction. */
  touchRequestOpenedAndQueueWebhook(
    requestId: string,
    nowIso: string,
    buildDelivery?: (openedAt: string) => {
      workspaceId: string;
      targetUrl: string;
      payloadJson: string;
      maxAttempts: number;
    } | null
  ): { firstOpen: boolean; delivery?: WebhookDeliveryRow } {
    return this.inTransaction(() => {
      const first = this.db
        .prepare("UPDATE requests SET last_opened_at = ? WHERE id = ? AND last_opened_at IS NULL")
        .run(nowIso, requestId);
      if (Number(first.changes ?? 0) > 0) {
        const spec = buildDelivery?.(nowIso);
        if (spec) {
          const delivery = this.createWebhookDelivery({
            workspaceId: spec.workspaceId,
            requestId,
            event: "request.opened",
            targetUrl: spec.targetUrl,
            payloadJson: spec.payloadJson,
            maxAttempts: spec.maxAttempts,
            nowIso,
          });
          return { firstOpen: true, delivery };
        }
        return { firstOpen: true };
      }
      this.db.prepare("UPDATE requests SET last_opened_at = ? WHERE id = ?").run(nowIso, requestId);
      return { firstOpen: false };
    });
  }

  listRequestItems(requestId: string): RequestItemRow[] {
    return this.db
      .prepare("SELECT * FROM request_items WHERE request_id = ? ORDER BY position ASC")
      .all(requestId) as unknown as RequestItemRow[];
  }

  getRequestItem(requestId: string, itemId: string): RequestItemRow | undefined {
    return this.db
      .prepare("SELECT * FROM request_items WHERE id = ? AND request_id = ?")
      .get(itemId, requestId) as RequestItemRow | undefined;
  }

  listUploadsForRequest(requestId: string): UploadRow[] {
    return this.db
      .prepare(
        `SELECT u.* FROM uploads u
         JOIN request_items ri ON ri.id = u.request_item_id
         WHERE ri.request_id = ? AND u.purged_at IS NULL
         ORDER BY u.created_at ASC`
      )
      .all(requestId) as unknown as UploadRow[];
  }

  getUploadForWorkspace(workspaceId: string, uploadId: string): (UploadRow & { request_id: string }) | undefined {
    return this.db
      .prepare(
        `SELECT u.*, ri.request_id
         FROM uploads u
         JOIN request_items ri ON ri.id = u.request_item_id
         JOIN requests r ON r.id = ri.request_id
         WHERE u.id = ? AND r.workspace_id = ? AND u.purged_at IS NULL`
      )
      .get(uploadId, workspaceId) as (UploadRow & { request_id: string }) | undefined;
  }

  countUploadsForItem(itemId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM uploads WHERE request_item_id = ? AND purged_at IS NULL")
      .get(itemId) as { c: number };
    return Number(row.c);
  }

  nextUploadSeqForItem(itemId: string): number {
    const rows = this.db
      .prepare("SELECT canonical_name FROM uploads WHERE request_item_id = ? AND purged_at IS NULL")
      .all(itemId) as Array<{ canonical_name: string }>;
    let maxSeq = rows.length;
    for (const r of rows) {
      const m = r.canonical_name.match(/_(\d+)\.[^.]+$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
    }
    return maxSeq + 1;
  }

  saveTextOrCheckboxSubmission(itemId: string, requestId: string, encryptedValue: string): void {
    this.inTransaction(() => {
      this.assertClientWriteOpenAndUnlocked(requestId, itemId);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE request_items
           SET value_encrypted = ?, status = 'submitted', review_note = NULL, client_na = 0, updated_at = ?
           WHERE id = ? AND request_id = ?`
        )
        .run(encryptedValue, now, itemId, requestId);
      this.recomputeRequestStatus(requestId);
    });
  }

  /** Client note on an item; notApplicable submits the item for review with the note as reason. */
  setClientNote(itemId: string, requestId: string, noteEncrypted: string | null, notApplicable: boolean): void {
    this.inTransaction(() => {
      const before = this.assertClientWriteOpenAndUnlocked(requestId, itemId);
      const now = new Date().toISOString();
      if (notApplicable) {
        this.db
          .prepare(
            `UPDATE request_items
             SET client_note_encrypted = ?, client_na = 1, status = 'submitted', review_note = NULL, updated_at = ?
             WHERE id = ? AND request_id = ?`
          )
          .run(noteEncrypted, now, itemId, requestId);
      } else {
        this.db
          .prepare(
            `UPDATE request_items SET client_note_encrypted = ?, client_na = 0, updated_at = ?
             WHERE id = ? AND request_id = ?`
          )
          .run(noteEncrypted, now, itemId, requestId);
        // Undoing N/A with nothing else provided returns the item to pending.
        if (
          before.client_na === 1 &&
          before.status === "submitted" &&
          !before.value_encrypted &&
          this.countUploadsForItem(itemId) === 0
        ) {
          this.db
            .prepare("UPDATE request_items SET status = 'pending' WHERE id = ? AND request_id = ?")
            .run(itemId, requestId);
        }
      }
      this.recomputeRequestStatus(requestId);
    });
  }

  getUploadForRequest(requestId: string, uploadId: string): (UploadRow & { request_id: string }) | undefined {
    return this.db
      .prepare(
        `SELECT u.*, ri.request_id FROM uploads u
         JOIN request_items ri ON ri.id = u.request_item_id
         WHERE u.id = ? AND ri.request_id = ? AND u.purged_at IS NULL`
      )
      .get(uploadId, requestId) as (UploadRow & { request_id: string }) | undefined;
  }

  /** Deletes the upload row; caller deletes the blob. Item falls back to pending when its last file goes. */
  deleteUpload(requestId: string, uploadId: string): { storageKey: string; itemId: string } | null {
    return this.inTransaction(() => {
      const upload = this.getUploadForRequest(requestId, uploadId);
      if (!upload) return null;
      this.assertClientWriteOpenAndUnlocked(requestId, upload.request_item_id);
      this.db.prepare("DELETE FROM uploads WHERE id = ?").run(uploadId);
      const item = this.getRequestItem(requestId, upload.request_item_id);
      if (item && item.status === "submitted" && item.client_na === 0 && this.countUploadsForItem(item.id) === 0) {
        this.db
          .prepare("UPDATE request_items SET status = 'pending', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), item.id);
      }
      this.recomputeRequestStatus(requestId);
      return { storageKey: upload.storage_key, itemId: upload.request_item_id };
    });
  }

  deleteOtherUploadsForItem(requestId: string, itemId: string, keepUploadId: string): string[] {
    return this.inTransaction(() => {
      const rows = this.db
        .prepare(
          `SELECT u.id, u.storage_key FROM uploads u
           JOIN request_items ri ON ri.id = u.request_item_id
           WHERE u.request_item_id = ? AND ri.request_id = ? AND u.id != ? AND u.purged_at IS NULL`
        )
        .all(itemId, requestId, keepUploadId) as Array<{ id: string; storage_key: string }>;
      if (rows.length === 0) return [];
      const del = this.db.prepare("DELETE FROM uploads WHERE id = ?");
      for (const row of rows) {
        del.run(row.id);
      }
      return rows.map((r) => r.storage_key);
    });
  }

  addUploads(
    entries: Array<{
      id?: string;
      itemId: string;
      requestId: string;
      originalName: string;
      canonicalName: string;
      detectedMime: string;
      sizeBytes: number;
      storageKey: string;
      encVersion?: string;
      ivHex: string;
      tagHex: string;
      saltHex: string;
      sha256Hex: string;
    }>
  ): UploadRow[] {
    if (entries.length === 0) return [];
    return this.inTransaction(() => {
      const { requestId, itemId } = entries[0];
      this.assertClientWriteOpenAndUnlocked(requestId, itemId);
      const now = new Date().toISOString();
      const insertStmt = this.db.prepare(
        `INSERT INTO uploads (
           id, request_item_id, original_name, canonical_name, detected_mime,
           size_bytes, storage_key, enc_version, enc_iv, enc_tag, enc_salt, sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const selectStmt = this.db.prepare("SELECT * FROM uploads WHERE id = ?");
      const rows: UploadRow[] = [];
      for (const params of entries) {
        const id = params.id ?? generateId("upl");
        insertStmt.run(
          id,
          params.itemId,
          params.originalName,
          params.canonicalName,
          params.detectedMime,
          params.sizeBytes,
          params.storageKey,
          params.encVersion ?? "v1",
          params.ivHex,
          params.tagHex,
          params.saltHex,
          params.sha256Hex,
          now
        );
        rows.push(selectStmt.get(id) as unknown as UploadRow);
      }

      this.db
        .prepare(
          `UPDATE request_items
           SET status = 'submitted', review_note = NULL, client_na = 0, updated_at = ?
           WHERE id = ? AND request_id = ?`
        )
        .run(now, itemId, requestId);

      this.recomputeRequestStatus(requestId);
      return rows;
    });
  }

  addUpload(params: {
    id?: string;
    itemId: string;
    requestId: string;
    originalName: string;
    canonicalName: string;
    detectedMime: string;
    sizeBytes: number;
    storageKey: string;
    encVersion?: string;
    ivHex: string;
    tagHex: string;
    saltHex: string;
    sha256Hex: string;
  }): UploadRow {
    return this.addUploads([params])[0];
  }

  reviewItem(params: {
    workspaceId: string;
    requestId: string;
    itemId: string;
    decision: "approved" | "rejected";
    note?: string;
    actor?: "operator" | "api_key";
    actorBy?: string;
  }): { justCompleted: boolean; request: RequestRow } {
    return this.inTransaction(() => {
      const now = new Date().toISOString();
      const before = this.getRequestById(params.workspaceId, params.requestId);
      if (!before) throw new Error("Request not found");
      const targetItem = this.getRequestItem(params.requestId, params.itemId);
      if (!targetItem) throw new Error("Item not found");

      if (params.decision === "rejected" && targetItem.kind === "checkbox") {
        this.db
          .prepare(
            `UPDATE request_items
             SET status = 'rejected', review_note = ?, value_encrypted = NULL, updated_at = ?
             WHERE id = ? AND request_id = ?`
          )
          .run(
            (params.note || "Please review and confirm.").trim(),
            now,
            params.itemId,
            params.requestId
          );
      } else {
        this.db
          .prepare(
            `UPDATE request_items
             SET status = ?, review_note = ?, updated_at = ?
             WHERE id = ? AND request_id = ?`
          )
          .run(
            params.decision,
            params.decision === "rejected" ? (params.note || "Please review and re-upload.").trim() : null,
            now,
            params.itemId,
            params.requestId
          );
      }

      this.logAudit(params.workspaceId, params.requestId, params.actor ?? "operator", `item.${params.decision}`, {
        itemId: params.itemId,
        note: params.decision === "rejected" ? params.note || "" : undefined,
        ...(params.actorBy ? { by: params.actorBy } : {}),
      });

      const after = this.recomputeRequestStatus(params.requestId);
      return {
        justCompleted: before.status !== "completed" && after.status === "completed",
        request: after,
      };
    });
  }

  approveAllSubmitted(
    workspaceId: string,
    requestId: string,
    actor: "operator" | "api_key" = "operator",
    actorBy?: string
  ): { approvedCount: number; justCompleted: boolean; request: RequestRow } {
    return this.inTransaction(() => {
      const now = new Date().toISOString();
      const before = this.getRequestById(workspaceId, requestId);
      if (!before) throw new Error("Request not found");

      const info = this.db
        .prepare(
          `UPDATE request_items
           SET status = 'approved', review_note = NULL, updated_at = ?
           WHERE request_id = ? AND status = 'submitted'`
        )
        .run(now, requestId);

      const approvedCount = Number(info.changes ?? 0);
      if (approvedCount > 0) {
        this.logAudit(workspaceId, requestId, actor, "request.approved_all_submitted", {
          count: approvedCount,
          ...(actorBy ? { by: actorBy } : {}),
        });
      }

      const after = this.recomputeRequestStatus(requestId);
      return {
        approvedCount,
        justCompleted: before.status !== "completed" && after.status === "completed",
        request: after,
      };
    });
  }

  recomputeRequestStatus(requestId: string): RequestRow {
    const req = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as unknown as RequestRow;
    if (req.status === "purged" || req.status === "expired") return req;

    const items = this.listRequestItems(requestId);
    const requiredItems = items.filter((i) => i.required === 1);
    const checkSet = requiredItems.length > 0 ? requiredItems : items;
    const allApproved = checkSet.length > 0 && checkSet.every((i) => i.status === "approved");
    const allSubmittedOrApproved =
      checkSet.length > 0 &&
      checkSet.every((i) => i.status === "submitted" || i.status === "approved");
    const hasRejected = items.some((i) => i.status === "rejected");
    const hasSubmitted = items.some((i) => i.status === "submitted");

    const now = new Date().toISOString();
    if (allApproved && !hasRejected && !hasSubmitted) {
      const completedAt = req.completed_at || now;
      const purgeAt = addDaysIso(completedAt, req.purge_after_days);
      this.db
        .prepare(
          `UPDATE requests
           SET status = 'completed', completed_at = ?, purge_at = ?, next_reminder_at = NULL
           WHERE id = ?`
        )
        .run(completedAt, purgeAt, requestId);
    } else if (allSubmittedOrApproved && !hasRejected) {
      this.db
        .prepare(
          "UPDATE requests SET status = 'in_review', completed_at = NULL, purge_at = NULL, next_reminder_at = NULL WHERE id = ?"
        )
        .run(requestId);
    } else {
      const nextReminder =
        req.next_reminder_at ||
        (req.reminders_sent < req.max_reminders && req.reminder_interval_days > 0
          ? addDaysIso(now, req.reminder_interval_days)
          : null);
      this.db
        .prepare(
          "UPDATE requests SET status = 'open', completed_at = NULL, purge_at = NULL, next_reminder_at = ? WHERE id = ?"
        )
        .run(nextReminder, requestId);
    }

    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as unknown as RequestRow;
  }

  toggleRemindersPaused(
    workspaceId: string,
    requestId: string,
    paused: boolean,
    actor: "operator" | "api_key" = "operator",
    actorBy?: string
  ): void {
    this.db
      .prepare("UPDATE requests SET reminders_paused = ? WHERE id = ? AND workspace_id = ?")
      .run(paused ? 1 : 0, requestId, workspaceId);
    this.logAudit(
      workspaceId,
      requestId,
      actor,
      paused ? "reminders.paused" : "reminders.resumed",
      actorBy ? { by: actorBy } : {}
    );
  }

  listDueReminders(nowIso = new Date().toISOString()): RequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM requests
         WHERE status = 'open'
           AND is_demo = 0
           AND reminders_paused = 0
           AND reminders_sent < max_reminders
           AND next_reminder_at IS NOT NULL
           AND next_reminder_at <= ?`
      )
      .all(nowIso) as unknown as RequestRow[];
  }

  deferReminderAfterError(requestId: string, nextReminderIso: string): void {
    this.db
      .prepare("UPDATE requests SET next_reminder_at = ? WHERE id = ?")
      .run(nextReminderIso, requestId);
  }

  clearNextReminder(requestId: string): void {
    this.db
      .prepare("UPDATE requests SET next_reminder_at = NULL WHERE id = ?")
      .run(requestId);
  }

  recordReminderSent(requestId: string, nowIso = new Date().toISOString()): void {
    const req = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as unknown as RequestRow;
    const sent = req.reminders_sent + 1;
    const nextReminder =
      sent < req.max_reminders && req.reminder_interval_days > 0
        ? addDaysIso(nowIso, req.reminder_interval_days)
        : null;
    this.db
      .prepare("UPDATE requests SET reminders_sent = ?, next_reminder_at = ? WHERE id = ?")
      .run(sent, nextReminder, requestId);
    this.logAudit(req.workspace_id, req.id, "system", "reminder.sent", {
      reminderNumber: sent,
      maxReminders: req.max_reminders,
    });
  }

  recordManualReminderSent(
    workspaceId: string,
    requestId: string,
    actorEmail: string,
    outstandingCount: number,
    nowIso = new Date().toISOString(),
    actor: "operator" | "api_key" = "operator"
  ): RequestRow {
    const req = this.getRequestById(workspaceId, requestId)!;
    const sent = req.reminders_sent + 1;
    const nextReminder =
      sent < req.max_reminders && req.reminder_interval_days > 0
        ? addDaysIso(nowIso, req.reminder_interval_days)
        : null;
    this.db
      .prepare(
        "UPDATE requests SET reminders_sent = ?, last_manual_reminder_at = ?, next_reminder_at = ? WHERE id = ? AND workspace_id = ?"
      )
      .run(sent, nowIso, nextReminder, requestId, workspaceId);
    const updated = this.getRequestById(workspaceId, requestId)!;
    try {
      this.logAudit(workspaceId, requestId, actor, "reminder.manual_sent", {
        by: actorEmail,
        outstandingCount,
        reminderNumber: sent,
      });
    } catch {
      // Best-effort audit after reminder state has committed.
    }
    return updated;
  }

  updateRequestDueAt(
    workspaceId: string,
    requestId: string,
    dueAt: string | null,
    actorEmail: string,
    actor: "operator" | "api_key" = "operator"
  ): RequestRow | null {
    const req = this.getRequestById(workspaceId, requestId);
    if (!req) return null;
    const deadlineChanged = dueAt !== req.due_at;
    this.db
      .prepare(
        "UPDATE requests SET due_at = ?, overdue_notified_at = CASE WHEN ? THEN NULL ELSE overdue_notified_at END WHERE id = ? AND workspace_id = ?"
      )
      .run(dueAt, deadlineChanged ? 1 : 0, requestId, workspaceId);
    this.logAudit(workspaceId, requestId, actor, "request.due_date_updated", {
      from: req.due_at,
      to: dueAt,
      by: actorEmail,
    });
    return this.getRequestById(workspaceId, requestId)!;
  }

  addRequestItem(
    workspaceId: string,
    requestId: string,
    item: TemplateItemSpec,
    actor: "operator" | "api_key" = "operator",
    actorBy?: string
  ): { item: RequestItemRow; request: RequestRow } | null {
    const req = this.getRequestById(workspaceId, requestId);
    if (!req) return null;
    const row = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 as pos FROM request_items WHERE request_id = ?")
      .get(requestId) as { pos: number };
    const pos = Number(row.pos);
    const itemId = generateId("itm");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO request_items (
           id, request_id, position, section, label, help_text, kind,
           required, validator, config_json, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        itemId,
        requestId,
        pos,
        item.section || "General",
        item.label,
        item.helpText || "",
        item.kind,
        item.required ? 1 : 0,
        item.validator || "none",
        JSON.stringify({
          allowedGroups: item.allowedGroups,
          maxFileMb: item.maxFileMb ?? 20,
          multiple: item.multiple ?? false,
          slug: item.slug || slugify(item.label, `item-${pos + 1}`),
        }),
        now
      );
    this.logAudit(workspaceId, requestId, actor, "item.added", {
      itemId,
      label: item.label,
      kind: item.kind,
      required: item.required,
      ...(actorBy ? { by: actorBy } : {}),
    });
    const updatedReq = this.recomputeRequestStatus(requestId);
    return {
      item: this.getRequestItem(requestId, itemId)!,
      request: updatedReq,
    };
  }

  setRemindersPausedBulk(
    workspaceId: string,
    ids: string[],
    paused: boolean,
    actor: "operator" | "api_key" = "operator",
    actorBy?: string
  ): string[] {
    const updatedIds: string[] = [];
    const closed = new Set(["completed", "purged", "expired"]);
    for (const id of new Set(ids)) {
      const req = this.getRequestById(workspaceId, id);
      if (!req || closed.has(req.status)) continue;
      if (req.reminders_paused !== (paused ? 1 : 0)) {
        this.toggleRemindersPaused(workspaceId, req.id, paused, actor, actorBy);
        updatedIds.push(req.id);
      }
    }
    return updatedIds;
  }

  listPurgeDueRequests(nowIso = new Date().toISOString()): RequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM requests
         WHERE status IN ('completed', 'expired')
           AND purge_at IS NOT NULL
           AND purge_at <= ?`
      )
      .all(nowIso) as unknown as RequestRow[];
  }

  markUploadPurged(uploadId: string, nowIso = new Date().toISOString()): void {
    this.db
      .prepare(
        `UPDATE uploads
         SET purged_at = ?, original_name = '[purged]', canonical_name = '[purged]', sha256 = ''
         WHERE id = ? AND purged_at IS NULL`
      )
      .run(nowIso, uploadId);
  }

  markRequestPurged(
    requestId: string,
    nowIso = new Date().toISOString(),
    purgedWebhook?: {
      workspaceId: string;
      targetUrl: string;
      payloadJson: string;
      maxAttempts: number;
    } | null
  ): { finalized: boolean; delivery?: WebhookDeliveryRow } {
    return this.inTransaction(() => {
      const req = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as unknown as
        | RequestRow
        | undefined;
      if (!req || req.status === "purged") {
        return { finalized: false };
      }
      this.db
        .prepare(
          `UPDATE uploads
           SET purged_at = ?, original_name = '[purged]', canonical_name = '[purged]', sha256 = ''
           WHERE request_item_id IN (SELECT id FROM request_items WHERE request_id = ?)`
        )
        .run(nowIso, requestId);
      this.db
        .prepare(
          `UPDATE request_items
           SET value_encrypted = NULL, client_note_encrypted = NULL, review_note = NULL, client_na = 0
           WHERE request_id = ?`
        )
        .run(requestId);
      this.db.prepare("DELETE FROM outbox_emails WHERE request_id = ?").run(requestId);
      this.db.prepare("DELETE FROM otp_codes WHERE request_id = ?").run(requestId);
      this.db.prepare("DELETE FROM client_sessions WHERE request_id = ?").run(requestId);
      // Shred pre-purge webhook payload copies so client name/email/notes cannot linger or retry after purge.
      this.db.prepare("DELETE FROM webhook_deliveries WHERE request_id = ?").run(requestId);
      this.db
        .prepare("UPDATE requests SET status = 'purged', next_reminder_at = NULL, token_encrypted = '' WHERE id = ?")
        .run(requestId);
      this.logAudit(req.workspace_id, req.id, "system", "request.purged", { purgedAt: nowIso });
      let delivery: WebhookDeliveryRow | undefined;
      if (purgedWebhook) {
        delivery = this.createWebhookDelivery({
          workspaceId: purgedWebhook.workspaceId,
          requestId: req.id,
          event: "request.purged",
          targetUrl: purgedWebhook.targetUrl,
          payloadJson: purgedWebhook.payloadJson,
          maxAttempts: purgedWebhook.maxAttempts,
          nowIso,
        });
      }
      return { finalized: true, delivery };
    });
  }

  createOtpCode(requestId: string, codeHash: string, ttlMinutes = 15, nowMs = Date.now()): void {
    const now = new Date(nowMs);
    const expires = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
    this.db
      .prepare("DELETE FROM otp_codes WHERE request_id = ? AND verified_at IS NULL")
      .run(requestId);
    this.db
      .prepare(
        `INSERT INTO otp_codes (id, request_id, code_hash, attempts, expires_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      )
      .run(generateId("otp"), requestId, codeHash, expires, now.toISOString());
  }

  getActiveOtpCode(requestId: string): { id: string; code_hash: string; attempts: number; expires_at: string } | undefined {
    return this.db
      .prepare(
        `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
         WHERE request_id = ? AND verified_at IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(requestId) as
      | { id: string; code_hash: string; attempts: number; expires_at: string }
      | undefined;
  }

  incrementOtpAttempts(otpId: string): void {
    this.db.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").run(otpId);
  }

  markOtpVerified(otpId: string): void {
    this.db
      .prepare("UPDATE otp_codes SET verified_at = ? WHERE id = ?")
      .run(new Date().toISOString(), otpId);
  }

  createClientSession(requestId: string, ttlHours = 12): string {
    const rawToken = generateMagicToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 3600_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO client_sessions (id, request_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(generateId("cses"), requestId, sha256Hex(rawToken), expiresAt, now.toISOString());
    return rawToken;
  }

  hasValidClientSession(requestId: string, rawToken: string | undefined): boolean {
    if (!rawToken) return false;
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT id FROM client_sessions
         WHERE request_id = ? AND token_hash = ? AND expires_at > ?`
      )
      .get(requestId, sha256Hex(rawToken), now) as { id: string } | undefined;
    return Boolean(row);
  }

  logAudit(
    workspaceId: string,
    requestId: string | null,
    actor: "operator" | "client" | "system" | "api_key",
    action: string,
    meta: Record<string, unknown>
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, request_id, actor, action, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        generateId("aud"),
        workspaceId,
        requestId,
        actor,
        action,
        JSON.stringify(meta),
        new Date().toISOString()
      );
  }

  listAuditEvents(requestId: string, limit = 50): AuditEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM audit_events WHERE request_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(requestId, limit) as unknown as AuditEventRow[];
  }

  saveOutboxEmail(params: {
    workspaceId: string;
    requestId: string | null;
    recipient: string;
    subject: string;
    textBody: string;
    htmlBody?: string | null;
    kind: string;
    isDemo?: boolean;
  }): OutboxEmailRow {
    const id = generateId("eml");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO outbox_emails (id, workspace_id, request_id, recipient, subject, text_body, html_body, kind, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.workspaceId,
        params.requestId,
        params.recipient.trim().toLowerCase(),
        params.subject,
        params.textBody,
        params.htmlBody ?? null,
        params.kind,
        params.isDemo ? 1 : 0,
        now
      );
    return this.db.prepare("SELECT * FROM outbox_emails WHERE id = ?").get(id) as unknown as OutboxEmailRow;
  }

  listOutboxEmails(workspaceId: string, limit = 100): OutboxEmailRow[] {
    return this.db
      .prepare(
        `SELECT * FROM outbox_emails WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(workspaceId, limit) as unknown as OutboxEmailRow[];
  }

  countOutboxEmails(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM outbox_emails WHERE workspace_id = ?")
      .get(workspaceId) as { c: number };
    return Number(row.c);
  }

  countAwaitingReview(workspaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT r.id) as c
         FROM requests r
         JOIN request_items ri ON ri.request_id = r.id
         WHERE r.workspace_id = ?
           AND r.status IN ('open', 'in_review')
           AND ri.status = 'submitted'`
      )
      .get(workspaceId) as { c: number };
    return Number(row.c);
  }

  listClients(workspaceId: string): ClientSummary[] {
    const rows = this.listRequests(workspaceId);
    const byEmail = new Map<string, ClientSummary>();

    for (const r of rows) {
      const email = r.client_email.trim().toLowerCase();
      const activity =
        r.last_opened_at && r.last_opened_at > r.created_at ? r.last_opened_at : r.created_at;
      const isActive = r.status === "open" || r.status === "in_review";
      const submittedCount = Number(r.submitted_items);
      const brief: ClientRequestBrief = {
        id: r.id,
        title: r.title,
        status: r.status,
        due_at: r.due_at,
        created_at: r.created_at,
        total_items: Number(r.total_items),
        approved_items: Number(r.approved_items),
        submitted_items: submittedCount,
        rejected_items: Number(r.rejected_items),
      };

      const existing = byEmail.get(email);
      if (!existing) {
        byEmail.set(email, {
          email,
          name: r.client_name,
          totalRequests: 1,
          activeRequests: isActive ? 1 : 0,
          awaitingReviewRequests: isActive && submittedCount > 0 ? 1 : 0,
          completedRequests: r.status === "completed" ? 1 : 0,
          lastActivityAt: activity,
          requests: [brief],
        });
      } else {
        existing.totalRequests += 1;
        if (isActive) existing.activeRequests += 1;
        if (isActive && submittedCount > 0) existing.awaitingReviewRequests += 1;
        if (r.status === "completed") existing.completedRequests += 1;
        if (activity > existing.lastActivityAt) existing.lastActivityAt = activity;
        existing.requests.push(brief);
      }
    }

    return Array.from(byEmail.values()).sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt)
    );
  }

  hasDemoData(workspaceId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 as found FROM requests WHERE workspace_id = ? AND is_demo = 1 LIMIT 1")
      .get(workspaceId) as { found: number } | undefined;
    return Boolean(row);
  }

  clearDemoData(workspaceId: string): { storageKeys: string[]; deletedRequests: number } {
    const keyRows = this.db
      .prepare(
        `SELECT u.storage_key
         FROM uploads u
         JOIN request_items ri ON ri.id = u.request_item_id
         JOIN requests r ON r.id = ri.request_id
         WHERE r.workspace_id = ? AND r.is_demo = 1 AND u.purged_at IS NULL`
      )
      .all(workspaceId) as Array<{ storage_key: string }>;

    const reqRes = this.db
      .prepare("DELETE FROM requests WHERE workspace_id = ? AND is_demo = 1")
      .run(workspaceId);
    this.db
      .prepare("DELETE FROM outbox_emails WHERE workspace_id = ? AND is_demo = 1")
      .run(workspaceId);

    return {
      storageKeys: keyRows.map((r) => r.storage_key),
      deletedRequests: Number(reqRes.changes ?? 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Scoped Workspace API Keys
  // ---------------------------------------------------------------------------
  createApiKey(params: {
    workspaceId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    createdByUserId: string | null;
    actorEmail?: string;
    expiresAt: string | null;
    maxActiveKeys?: number;
    nowIso?: string;
  }): ApiKeyRow {
    return this.inTransaction(() => {
      const now = params.nowIso ?? new Date().toISOString();
      if (params.maxActiveKeys && this.countActiveApiKeys(params.workspaceId, now) >= params.maxActiveKeys) {
        throw new Error(`Active API key limit (${params.maxActiveKeys}) reached. Revoke unused keys first.`);
      }
      const id = generateId("key");
      this.db
        .prepare(
          `INSERT INTO api_keys (
             id, workspace_id, name, key_prefix, key_hash, scopes_json,
             created_by_user_id, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.workspaceId,
          params.name.trim(),
          params.keyPrefix,
          params.keyHash,
          JSON.stringify(params.scopes),
          params.createdByUserId,
          params.expiresAt,
          now
        );
      if (params.actorEmail) {
        this.logAudit(params.workspaceId, null, "operator", "api_key.created", {
          apiKeyId: id,
          name: params.name.trim(),
          keyPrefix: params.keyPrefix,
          scopes: params.scopes,
          expiresAt: params.expiresAt,
          by: params.actorEmail,
        });
      }
      return this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as unknown as ApiKeyRow;
    });
  }

  countActiveApiKeys(workspaceId: string, nowIso = new Date().toISOString()): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM api_keys
         WHERE workspace_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(workspaceId, nowIso) as { c: number };
    return Number(row.c);
  }

  listApiKeys(workspaceId: string): ApiKeyRow[] {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as unknown as ApiKeyRow[];
  }

  getApiKeyByHash(keyHash: string): ApiKeyRow | undefined {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ?")
      .get(keyHash) as ApiKeyRow | undefined;
  }

  touchApiKeyLastUsed(id: string, nowIso: string): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(nowIso, id);
  }

  revokeApiKey(workspaceId: string, id: string, nowIso = new Date().toISOString()): ApiKeyRow | null {
    const existing = this.db
      .prepare("SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as ApiKeyRow | undefined;
    if (!existing) return null;
    if (!existing.revoked_at) {
      this.db
        .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ?")
        .run(nowIso, id, workspaceId);
    }
    return this.db
      .prepare("SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as unknown as ApiKeyRow;
  }

  // ---------------------------------------------------------------------------
  // Durable Webhook Deliveries & Overdue Detection
  // ---------------------------------------------------------------------------
  createWebhookDelivery(params: {
    workspaceId: string;
    requestId: string | null;
    event: string;
    targetUrl: string;
    payloadJson: string;
    maxAttempts?: number;
    nowIso?: string;
  }): WebhookDeliveryRow {
    const id = generateId("whd");
    const now = params.nowIso ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries (
           id, workspace_id, request_id, event, target_url, payload_json,
           status, attempts, max_attempts, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.workspaceId,
        params.requestId,
        params.event,
        params.targetUrl,
        params.payloadJson,
        params.maxAttempts ?? 6,
        now,
        now,
        now
      );
    return this.getWebhookDeliveryById(id)!;
  }

  getWebhookDeliveryById(id: string): WebhookDeliveryRow | undefined {
    return this.db
      .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(id) as WebhookDeliveryRow | undefined;
  }

  getWebhookDeliveryForWorkspace(workspaceId: string, id: string): WebhookDeliveryRow | undefined {
    return this.db
      .prepare("SELECT * FROM webhook_deliveries WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as WebhookDeliveryRow | undefined;
  }

  listWebhookDeliveries(
    workspaceId: string,
    options?: { status?: WebhookDeliveryStatus; limit?: number; offset?: number } | number
  ): WebhookDeliveryRow[] {
    const opts = typeof options === "number" ? { limit: options } : (options ?? {});
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    if (opts.status) {
      return this.db
        .prepare(
          "SELECT * FROM webhook_deliveries WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        .all(workspaceId, opts.status, limit, offset) as unknown as WebhookDeliveryRow[];
    }
    return this.db
      .prepare(
        "SELECT * FROM webhook_deliveries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
      .all(workspaceId, limit, offset) as unknown as WebhookDeliveryRow[];
  }

  countWebhookDeliveries(workspaceId: string, status?: WebhookDeliveryStatus): number {
    if (status) {
      const row = this.db
        .prepare("SELECT COUNT(*) as c FROM webhook_deliveries WHERE workspace_id = ? AND status = ?")
        .get(workspaceId, status) as { c: number };
      return Number(row.c);
    }
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM webhook_deliveries WHERE workspace_id = ?")
      .get(workspaceId) as { c: number };
    return Number(row.c);
  }

  listDueWebhookDeliveries(nowIso = new Date().toISOString(), limit = 50): WebhookDeliveryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE status IN ('pending', 'retrying', 'in_flight')
           AND next_attempt_at IS NOT NULL
           AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`
      )
      .all(nowIso, limit) as unknown as WebhookDeliveryRow[];
  }

  /**
   * Atomically claims a webhook delivery before any outbound I/O so concurrent immediate
   * dispatch and cron retry sweeps cannot send duplicate POSTs or overwrite newer outcomes.
   * Crashed workers recover automatically once the 2-minute in_flight lease expires.
   */
  claimWebhookDelivery(params: {
    id: string;
    expectedUpdatedAt: string;
    claimToken: string;
    leaseUntilIso: string;
    isReplay: boolean;
  }): WebhookDeliveryRow | null {
    const sql = params.isReplay
      ? `UPDATE webhook_deliveries
         SET status = 'in_flight', next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND status != 'in_flight' AND updated_at = ?`
      : `UPDATE webhook_deliveries
         SET status = 'in_flight', next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retrying', 'in_flight') AND updated_at = ?`;
    const info = this.db
      .prepare(sql)
      .run(params.leaseUntilIso, params.claimToken, params.id, params.expectedUpdatedAt);
    if (Number(info.changes ?? 0) === 0) return null;
    return this.getWebhookDeliveryById(params.id) ?? null;
  }

  completeWebhookDeliveryAttempt(params: {
    id: string;
    claimToken: string;
    targetUrl: string;
    status: WebhookDeliveryStatus;
    attempts: number;
    lastStatusCode: number | null;
    lastError: string | null;
    nextAttemptAt: string | null;
    deliveredAt: string | null;
    nowIso: string;
  }): WebhookDeliveryRow | undefined {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET target_url = ?, status = ?, attempts = ?, last_status_code = ?,
             last_error = ?, next_attempt_at = ?, delivered_at = ?, updated_at = ?
         WHERE id = ? AND updated_at = ?`
      )
      .run(
        params.targetUrl,
        params.status,
        params.attempts,
        params.lastStatusCode,
        params.lastError,
        params.nextAttemptAt,
        params.deliveredAt,
        params.nowIso,
        params.id,
        params.claimToken
      );
    return this.getWebhookDeliveryById(params.id);
  }

  listNewlyOverdueRequests(nowIso = new Date().toISOString()): RequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM requests
         WHERE status IN ('open', 'in_review')
           AND is_demo = 0
           AND due_at IS NOT NULL
           AND due_at <= ?
           AND overdue_notified_at IS NULL`
      )
      .all(nowIso) as unknown as RequestRow[];
  }

  /**
   * Atomically verifies the selected deadline is still unchanged and overdue, marks
   * overdue_notified_at, writes the audit event, and queues any request.overdue webhook delivery.
   */
  claimOverdueNotification(params: {
    requestId: string;
    workspaceId: string;
    expectedDueAt: string;
    nowIso: string;
    webhookDelivery?: {
      targetUrl: string;
      payloadJson: string;
      maxAttempts: number;
    } | null;
  }): { claimed: boolean; delivery?: WebhookDeliveryRow } {
    return this.inTransaction(() => {
      const info = this.db
        .prepare(
          `UPDATE requests
           SET overdue_notified_at = ?
           WHERE id = ?
             AND workspace_id = ?
             AND status IN ('open', 'in_review')
             AND due_at = ?
             AND due_at <= ?
             AND overdue_notified_at IS NULL`
        )
        .run(
          params.nowIso,
          params.requestId,
          params.workspaceId,
          params.expectedDueAt,
          params.nowIso
        );
      if (Number(info.changes ?? 0) === 0) {
        return { claimed: false };
      }
      this.logAudit(params.workspaceId, params.requestId, "system", "request.overdue", {
        dueAt: params.expectedDueAt,
      });
      let delivery: WebhookDeliveryRow | undefined;
      if (params.webhookDelivery) {
        delivery = this.createWebhookDelivery({
          workspaceId: params.workspaceId,
          requestId: params.requestId,
          event: "request.overdue",
          targetUrl: params.webhookDelivery.targetUrl,
          payloadJson: params.webhookDelivery.payloadJson,
          maxAttempts: params.webhookDelivery.maxAttempts,
          nowIso: params.nowIso,
        });
      }
      return { claimed: true, delivery };
    });
  }
}
