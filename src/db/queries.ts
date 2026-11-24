import type { DatabaseSync } from "node:sqlite";
import { encryptField, generateId, generateMagicToken, sha256Hex } from "../security/crypto.js";
import { BUILTIN_TEMPLATES, type ItemKind, type TemplateItemSpec } from "../templates/presets.js";
import type { ValidatorKey } from "../validators/index.js";

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
  created_at: string;
}

export interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
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
  constructor(private readonly db: DatabaseSync) {}

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    return Number(row.c);
  }

  createWorkspaceWithUser(params: {
    workspaceName: string;
    email: string;
    passwordHash: string;
    plan: "self_hosted" | "free" | "pro";
    maxActiveRequests: number;
    maxStorageBytes: number;
  }): { workspace: WorkspaceRow; user: UserRow } {
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
  }): { request: RequestRow; magicToken: string } {
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

    this.logAudit(params.workspaceId, id, "operator", "request.created", {
      clientEmail: params.clientEmail.trim().toLowerCase(),
      itemCount: params.items.length,
      requireOtp: params.requireOtp,
      isDemo: Boolean(params.isDemo),
    });

    return { request: this.getRequestById(params.workspaceId, id)!, magicToken };
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

  touchRequestOpened(requestId: string): void {
    this.db
      .prepare("UPDATE requests SET last_opened_at = ? WHERE id = ?")
      .run(new Date().toISOString(), requestId);
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

  saveTextOrCheckboxSubmission(itemId: string, requestId: string, encryptedValue: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE request_items
         SET value_encrypted = ?, status = 'submitted', review_note = NULL, client_na = 0, updated_at = ?
         WHERE id = ? AND request_id = ?`
      )
      .run(encryptedValue, now, itemId, requestId);
    this.recomputeRequestStatus(requestId);
  }

  /** Client note on an item; notApplicable submits the item for review with the note as reason. */
  setClientNote(itemId: string, requestId: string, noteEncrypted: string | null, notApplicable: boolean): void {
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
      const before = this.getRequestItem(requestId, itemId);
      this.db
        .prepare(
          `UPDATE request_items SET client_note_encrypted = ?, client_na = 0, updated_at = ?
           WHERE id = ? AND request_id = ?`
        )
        .run(noteEncrypted, now, itemId, requestId);
      // Undoing N/A with nothing else provided returns the item to pending.
      if (
        before?.client_na === 1 &&
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
    const upload = this.getUploadForRequest(requestId, uploadId);
    if (!upload) return null;
    this.db.prepare("DELETE FROM uploads WHERE id = ?").run(uploadId);
    const item = this.getRequestItem(requestId, upload.request_item_id);
    if (item && item.status === "submitted" && item.client_na === 0 && this.countUploadsForItem(item.id) === 0) {
      this.db
        .prepare("UPDATE request_items SET status = 'pending', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), item.id);
    }
    this.recomputeRequestStatus(requestId);
    return { storageKey: upload.storage_key, itemId: upload.request_item_id };
  }

  addUpload(params: {
    itemId: string;
    requestId: string;
    originalName: string;
    canonicalName: string;
    detectedMime: string;
    sizeBytes: number;
    storageKey: string;
    ivHex: string;
    tagHex: string;
    saltHex: string;
    sha256Hex: string;
  }): UploadRow {
    const id = generateId("upl");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO uploads (
           id, request_item_id, original_name, canonical_name, detected_mime,
           size_bytes, storage_key, enc_iv, enc_tag, enc_salt, sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.itemId,
        params.originalName,
        params.canonicalName,
        params.detectedMime,
        params.sizeBytes,
        params.storageKey,
        params.ivHex,
        params.tagHex,
        params.saltHex,
        params.sha256Hex,
        now
      );

    this.db
      .prepare(
        `UPDATE request_items
         SET status = 'submitted', review_note = NULL, client_na = 0, updated_at = ?
         WHERE id = ? AND request_id = ?`
      )
      .run(now, params.itemId, params.requestId);

    this.recomputeRequestStatus(params.requestId);
    return this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as unknown as UploadRow;
  }

  reviewItem(params: {
    workspaceId: string;
    requestId: string;
    itemId: string;
    decision: "approved" | "rejected";
    note?: string;
  }): { justCompleted: boolean; request: RequestRow } {
    const now = new Date().toISOString();
    const before = this.getRequestById(params.workspaceId, params.requestId);
    if (!before) throw new Error("Request not found");

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

    this.logAudit(params.workspaceId, params.requestId, "operator", `item.${params.decision}`, {
      itemId: params.itemId,
      note: params.decision === "rejected" ? params.note || "" : undefined,
    });

    const after = this.recomputeRequestStatus(params.requestId);
    return {
      justCompleted: before.status !== "completed" && after.status === "completed",
      request: after,
    };
  }

  approveAllSubmitted(
    workspaceId: string,
    requestId: string
  ): { approvedCount: number; justCompleted: boolean; request: RequestRow } {
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
      this.logAudit(workspaceId, requestId, "operator", "request.approved_all_submitted", {
        count: approvedCount,
      });
    }

    const after = this.recomputeRequestStatus(requestId);
    return {
      approvedCount,
      justCompleted: before.status !== "completed" && after.status === "completed",
      request: after,
    };
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

    const now = new Date().toISOString();
    if (allApproved) {
      const completedAt = req.completed_at || now;
      const purgeAt = req.purge_at || addDaysIso(completedAt, req.purge_after_days);
      this.db
        .prepare(
          `UPDATE requests
           SET status = 'completed', completed_at = ?, purge_at = ?, next_reminder_at = NULL
           WHERE id = ?`
        )
        .run(completedAt, purgeAt, requestId);
    } else if (allSubmittedOrApproved && !hasRejected) {
      this.db
        .prepare("UPDATE requests SET status = 'in_review', next_reminder_at = NULL WHERE id = ?")
        .run(requestId);
    } else {
      const nextReminder =
        req.next_reminder_at ||
        (req.reminders_sent < req.max_reminders && req.reminder_interval_days > 0
          ? addDaysIso(now, req.reminder_interval_days)
          : null);
      this.db
        .prepare(
          "UPDATE requests SET status = 'open', completed_at = NULL, next_reminder_at = ? WHERE id = ?"
        )
        .run(nextReminder, requestId);
    }

    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as unknown as RequestRow;
  }

  toggleRemindersPaused(workspaceId: string, requestId: string, paused: boolean): void {
    this.db
      .prepare("UPDATE requests SET reminders_paused = ? WHERE id = ? AND workspace_id = ?")
      .run(paused ? 1 : 0, requestId, workspaceId);
    this.logAudit(
      workspaceId,
      requestId,
      "operator",
      paused ? "reminders.paused" : "reminders.resumed",
      {}
    );
  }

  listDueReminders(nowIso = new Date().toISOString()): RequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM requests
         WHERE status = 'open'
           AND reminders_paused = 0
           AND reminders_sent < max_reminders
           AND next_reminder_at IS NOT NULL
           AND next_reminder_at <= ?`
      )
      .all(nowIso) as unknown as RequestRow[];
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
    nowIso = new Date().toISOString()
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
    this.logAudit(workspaceId, requestId, "operator", "reminder.manual_sent", {
      by: actorEmail,
      outstandingCount,
      reminderNumber: sent,
    });
    return this.getRequestById(workspaceId, requestId)!;
  }

  updateRequestDueAt(
    workspaceId: string,
    requestId: string,
    dueAt: string | null,
    actorEmail: string
  ): RequestRow | null {
    const req = this.getRequestById(workspaceId, requestId);
    if (!req) return null;
    this.db
      .prepare("UPDATE requests SET due_at = ? WHERE id = ? AND workspace_id = ?")
      .run(dueAt, requestId, workspaceId);
    this.logAudit(workspaceId, requestId, "operator", "request.due_date_updated", {
      from: req.due_at,
      to: dueAt,
      by: actorEmail,
    });
    return this.getRequestById(workspaceId, requestId)!;
  }

  addRequestItem(
    workspaceId: string,
    requestId: string,
    item: TemplateItemSpec
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
    this.logAudit(workspaceId, requestId, "operator", "item.added", {
      itemId,
      label: item.label,
      kind: item.kind,
      required: item.required,
    });
    const updatedReq = this.recomputeRequestStatus(requestId);
    return {
      item: this.getRequestItem(requestId, itemId)!,
      request: updatedReq,
    };
  }

  setRemindersPausedBulk(workspaceId: string, ids: string[], paused: boolean): string[] {
    const updatedIds: string[] = [];
    const closed = new Set(["completed", "purged", "expired"]);
    for (const id of new Set(ids)) {
      const req = this.getRequestById(workspaceId, id);
      if (!req || closed.has(req.status)) continue;
      if (req.reminders_paused !== (paused ? 1 : 0)) {
        this.toggleRemindersPaused(workspaceId, req.id, paused);
        updatedIds.push(req.id);
      }
    }
    return updatedIds;
  }

  listPurgeDueRequests(nowIso = new Date().toISOString()): RequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM requests
         WHERE status != 'purged'
           AND purge_at IS NOT NULL
           AND purge_at <= ?`
      )
      .all(nowIso) as unknown as RequestRow[];
  }

  markRequestPurged(requestId: string, nowIso = new Date().toISOString()): void {
    const req = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as unknown as RequestRow;
    this.db
      .prepare(
        `UPDATE uploads SET purged_at = ?
         WHERE request_item_id IN (SELECT id FROM request_items WHERE request_id = ?)
           AND purged_at IS NULL`
      )
      .run(nowIso, requestId);
    this.db
      .prepare("UPDATE request_items SET value_encrypted = NULL WHERE request_id = ?")
      .run(requestId);
    this.db
      .prepare("UPDATE requests SET status = 'purged', next_reminder_at = NULL WHERE id = ?")
      .run(requestId);
    this.logAudit(req.workspace_id, req.id, "system", "request.purged", { purgedAt: nowIso });
  }

  createOtpCode(requestId: string, codeHash: string, ttlMinutes = 15): void {
    const now = new Date();
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
    actor: "operator" | "client" | "system",
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
}
