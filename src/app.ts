import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { DatabaseSync } from "node:sqlite";
import { ZipFile } from "yazl";
import {
  createEmailAdapterFromOptions,
  resolveWorkspaceEmail,
  type EmailAdapter,
  type WorkspaceEmailSecrets,
} from "./adapters/email.js";
import type { StorageAdapter } from "./adapters/storage.js";
import type { AppConfig, EmailBackend } from "./config.js";
import { slugify, Store, type UserRow, type WorkspaceRow } from "./db/queries.js";
import {
  emailBrand,
  inviteEmail,
  isHexColor,
  otpEmail,
  reminderEmail,
  revisionEmail,
  testDeliveryEmail,
  type RenderedEmail,
} from "./emails/templates.js";
import { seedDemoWorkspace } from "./jobs/demo.js";
import { dispatchCompletionWebhook, dispatchTestWebhook } from "./jobs/webhook.js";
import { generateOtpCode, hashPassword, verifyOtpCode, verifyPassword } from "./security/auth.js";
import {
  createDecryptStream,
  decryptField,
  encryptBuffer,
  encryptField,
} from "./security/crypto.js";
import { detectFileSignature, resolveAllowedMimes } from "./security/magic-bytes.js";
import type { TemplateItemSpec } from "./templates/presets.js";
import {
  getValidatorHint,
  isKnownValidator,
  listValidators,
  maskSensitiveValue,
  SENSITIVE_VALIDATORS,
  validateTextValue,
} from "./validators/index.js";

const SESSION_COOKIE = "gg_session";
const CLIENT_COOKIE_PREFIX = "gg_c_";
const MAX_LOGO_BYTES = 200 * 1024;
const LOGO_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_CLIENT_NOTE_CHARS = 1000;
const DEFAULT_MANUAL_REMINDER_COOLDOWN_MS = 15 * 60_000;

interface AppEnv {
  Variables: {
    auth?: { user: UserRow; workspace: WorkspaceRow };
  };
}

export interface GatherGateAppDeps {
  config: AppConfig;
  db: DatabaseSync;
  storage: StorageAdapter;
  email: EmailAdapter;
  fetchImpl?: typeof fetch;
  clientDistDir?: string;
  manualReminderCooldownMs?: number;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

function sanitizeWorkspace(ws: WorkspaceRow) {
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    plan: ws.plan,
    max_active_requests: ws.max_active_requests,
    max_storage_bytes: ws.max_storage_bytes,
    webhook_url: ws.webhook_url,
    has_webhook_secret: Boolean(ws.webhook_secret),
    brand_color: ws.brand_color,
    has_logo: Boolean(ws.logo_b64),
    support_email: ws.support_email,
    support_phone: ws.support_phone,
    created_at: ws.created_at,
  };
}

/** Branding shown to end clients; never includes secrets or plan details. */
function publicBranding(ws: WorkspaceRow) {
  return {
    name: ws.name,
    brandColor: ws.brand_color,
    logoDataUrl: ws.logo_b64 && ws.logo_mime ? `data:${ws.logo_mime};base64,${ws.logo_b64}` : null,
    supportEmail: ws.support_email,
    supportPhone: ws.support_phone,
  };
}

function hasCrLf(value: string): boolean {
  return /[\r\n]/.test(value);
}

function extractAddress(raw: string): string {
  const match = raw.match(/^[^<>]*<([^<>]+)>$/);
  return (match ? match[1] : raw).trim();
}

function resolveDefaultClientDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "client", "dist");
}

function normalizeTemplateItems(raw: unknown): TemplateItemSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("At least one checklist item is required.");
  }
  return raw.map((entry, idx) => {
    const item = entry as Partial<TemplateItemSpec>;
    const label = String(item.label || "").trim();
    if (!label) throw new Error(`Item #${idx + 1} is missing a label.`);
    const kind = item.kind;
    if (kind !== "file" && kind !== "text" && kind !== "textarea" && kind !== "checkbox") {
      throw new Error(`Item "${label}" has invalid kind.`);
    }
    const validator = item.validator || "none";
    if (!isKnownValidator(validator)) {
      throw new Error(`Item "${label}" uses unknown validator "${validator}".`);
    }
    return {
      section: String(item.section || "General").trim() || "General",
      label,
      helpText: String(item.helpText || "").trim(),
      kind,
      required: Boolean(item.required),
      validator,
      allowedGroups: Array.isArray(item.allowedGroups) ? item.allowedGroups : undefined,
      maxFileMb: typeof item.maxFileMb === "number" && item.maxFileMb > 0 ? item.maxFileMb : 20,
      multiple: Boolean(item.multiple),
      slug: item.slug ? slugify(item.slug) : slugify(label, `item-${idx + 1}`),
    };
  });
}

export function createApp(deps: GatherGateAppDeps) {
  const { config, storage, email } = deps;
  const store = new Store(deps.db);
  const app = new Hono<AppEnv>();
  const secureCookie = config.baseUrl.startsWith("https://");
  const clientDistDir = deps.clientDistDir ?? resolveDefaultClientDistDir();

  // Hardened response headers; Referrer-Policy: no-referrer protects magic-link URLs.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    const isPreview = c.req.path.startsWith("/api/uploads/") && c.req.path.endsWith("/preview");
    if (!isPreview) {
      c.header("X-Frame-Options", "DENY");
    }
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "gathergate" }));

  function requireAuth(c: import("hono").Context<AppEnv>) {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    return store.getUserBySessionToken(token);
  }

  function summarizeWorkspaceEmail(ws: WorkspaceRow) {
    const resolved = resolveWorkspaceEmail(ws, config, config.masterKey);
    return {
      source: resolved.source,
      backend: resolved.backend,
      from: resolved.from,
      replyTo: resolved.replyTo,
      smtp: {
        host: resolved.smtp?.host || "",
        port: resolved.smtp?.port ?? 587,
        secure: Boolean(resolved.smtp?.secure),
        user: resolved.smtp?.user || "",
        hasPass: Boolean(resolved.smtp?.pass),
      },
      resend: {
        hasApiKey: Boolean(resolved.resendApiKey),
      },
    };
  }

  async function sendEmailTracked(params: {
    workspace?: WorkspaceRow;
    workspaceId: string;
    requestId: string | null;
    to: string;
    message: RenderedEmail;
    kind: string;
    isDemo?: boolean;
  }) {
    const ws = params.workspace ?? store.getWorkspaceById(params.workspaceId);
    const resolved = ws ? resolveWorkspaceEmail(ws, config, config.masterKey) : null;
    const { subject, text, html } = params.message;
    if (resolved && resolved.source === "workspace") {
      const adapter = createEmailAdapterFromOptions({
        backend: resolved.backend,
        from: resolved.from,
        resendApiKey: resolved.resendApiKey,
        smtp: resolved.smtp,
        fetchImpl: deps.fetchImpl,
      });
      await adapter.send({
        to: params.to,
        subject,
        text,
        html,
        replyTo: resolved.replyTo || undefined,
      });
    } else {
      await email.send({ to: params.to, subject, text, html });
    }
    const effectiveBackend = resolved?.backend ?? config.emailBackend;
    if (effectiveBackend === "console") {
      store.saveOutboxEmail({
        workspaceId: params.workspaceId,
        requestId: params.requestId,
        recipient: params.to,
        subject,
        textBody: text,
        htmlBody: html,
        kind: params.kind,
        isDemo: params.isDemo,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Session & Operator Auth (/api/*)
  // ---------------------------------------------------------------------------
  app.get("/api/session", (c) => {
    const needsSetup = store.countUsers() === 0;
    const auth = needsSetup ? null : requireAuth(c);
    const resolvedEmail = auth ? resolveWorkspaceEmail(auth.workspace, config, config.masterKey) : null;
    return c.json({
      needsSetup,
      multiTenant: config.multiTenant,
      user: auth ? { id: auth.user.id, email: auth.user.email, displayName: auth.user.display_name } : null,
      workspace: auth ? sanitizeWorkspace(auth.workspace) : null,
      readiness: {
        storageBackend: config.storageBackend,
        emailBackend: resolvedEmail ? resolvedEmail.backend : config.emailBackend,
        cronIntervalMinutes: config.cronIntervalMinutes,
        defaultPurgeDays: config.defaultPurgeDays,
        hasDemoData: auth ? store.hasDemoData(auth.workspace.id) : false,
        outboxCount: auth ? store.countOutboxEmails(auth.workspace.id) : 0,
        awaitingReviewCount: auth ? store.countAwaitingReview(auth.workspace.id) : 0,
      },
    });
  });

  app.post("/api/setup", async (c) => {
    if (store.countUsers() > 0) {
      return c.json({ error: "Setup has already been completed." }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceName?: string;
      email?: string;
      password?: string;
      loadDemo?: boolean;
    };
    const workspaceName = String(body.workspaceName || "").trim();
    const userEmail = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const loadDemo = body.loadDemo !== false;

    if (!workspaceName || !userEmail.includes("@") || password.length < 10) {
      return c.json(
        { error: "Provide workspace name, valid email, and password (min 10 characters)." },
        400
      );
    }

    const { user, workspace } = store.createWorkspaceWithUser({
      workspaceName,
      email: userEmail,
      passwordHash: hashPassword(password),
      plan: config.multiTenant ? "pro" : "self_hosted",
      maxActiveRequests: 0,
      maxStorageBytes: 0,
    });

    if (loadDemo) {
      await seedDemoWorkspace({
        store,
        storage,
        workspaceId: workspace.id,
        masterKey: config.masterKey,
        baseUrl: config.baseUrl,
      });
    }

    const sessionToken = store.createSession(user.id);
    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookie,
      path: "/",
      maxAge: 14 * 86400,
    });
    return c.json({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name },
      workspace: sanitizeWorkspace(workspace),
    });
  });

  app.post("/api/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    const userEmail = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = store.getUserByEmail(userEmail);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return c.json({ error: "Invalid email or password." }, 401);
    }

    const sessionToken = store.createSession(user.id);
    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookie,
      path: "/",
      maxAge: 14 * 86400,
    });
    const workspace = store.getWorkspaceById(user.workspace_id)!;
    return c.json({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name },
      workspace: sanitizeWorkspace(workspace),
    });
  });

  app.post("/api/signup", async (c) => {
    if (!config.multiTenant) {
      return c.json({ error: "Multi-tenant signup is disabled." }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceName?: string;
      email?: string;
      password?: string;
    };
    const workspaceName = String(body.workspaceName || "").trim();
    const userEmail = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!workspaceName || !userEmail.includes("@") || password.length < 10) {
      return c.json(
        { error: "Provide workspace name, valid email, and password (min 10 characters)." },
        400
      );
    }
    if (store.getUserByEmail(userEmail)) {
      return c.json({ error: "An account with this email already exists." }, 409);
    }

    const { user, workspace } = store.createWorkspaceWithUser({
      workspaceName,
      email: userEmail,
      passwordHash: hashPassword(password),
      plan: "free",
      maxActiveRequests: config.freeMaxActiveRequests,
      maxStorageBytes: config.freeMaxStorageBytes,
    });
    const sessionToken = store.createSession(user.id);
    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookie,
      path: "/",
      maxAge: 14 * 86400,
    });
    return c.json({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name },
      workspace: sanitizeWorkspace(workspace),
    });
  });

  app.post("/api/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) store.deleteSessionByToken(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Requests, Review & Exports
  // ---------------------------------------------------------------------------
  app.get("/api/clients", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ clients: store.listClients(auth.workspace.id) });
  });

  app.get("/api/requests", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);

    const rows = store.listRequests(auth.workspace.id);
    const enriched = rows.map((r) => {
      const magicToken = decryptField(config.masterKey, r.token_encrypted, r.id);
      return {
        id: r.id,
        title: r.title,
        client_name: r.client_name,
        client_email: r.client_email,
        status: r.status,
        require_otp: r.require_otp === 1,
        reminders_sent: r.reminders_sent,
        max_reminders: r.max_reminders,
        reminders_paused: r.reminders_paused === 1,
        next_reminder_at: r.next_reminder_at,
        purge_at: r.purge_at,
        due_at: r.due_at,
        last_opened_at: r.last_opened_at,
        is_demo: r.is_demo === 1,
        created_at: r.created_at,
        total_items: Number(r.total_items || 0),
        approved_items: Number(r.approved_items || 0),
        submitted_items: Number(r.submitted_items || 0),
        rejected_items: Number(r.rejected_items || 0),
        portal_url: `${config.baseUrl}/c/${magicToken}`,
      };
    });

    const kpis = {
      active: enriched.filter((r) => r.status === "open" || r.status === "in_review").length,
      awaitingReview: enriched.filter((r) => r.submitted_items > 0 && r.status !== "purged").length,
      needsRevision: enriched.filter((r) => r.rejected_items > 0 && r.status !== "purged").length,
      completed: enriched.filter((r) => r.status === "completed").length,
    };

    const demoCandidate =
      enriched.find((r) => r.is_demo && !r.require_otp && r.status !== "completed" && r.status !== "purged") ??
      enriched.find((r) => r.is_demo && r.status !== "purged");

    return c.json({
      requests: enriched,
      kpis,
      storageBytes: store.getWorkspaceStorageBytes(auth.workspace.id),
      activeCount: store.countActiveRequests(auth.workspace.id),
      workspace: sanitizeWorkspace(auth.workspace),
      hasDemoData: enriched.some((r) => r.is_demo),
      demoPortalUrl: demoCandidate?.portal_url ?? null,
    });
  });

  app.post("/api/requests", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);

    if (
      auth.workspace.max_active_requests > 0 &&
      store.countActiveRequests(auth.workspace.id, true) >= auth.workspace.max_active_requests
    ) {
      return c.json(
        {
          error: `Active request cap (${auth.workspace.max_active_requests}) reached on current plan.`,
        },
        403
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
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
    };

    const templateId = String(body.templateId || "");
    const title = String(body.title || "").trim();
    const clientName = String(body.clientName || "").trim();
    const clientEmail = String(body.clientEmail || "").trim().toLowerCase();
    const requireOtp = Boolean(body.requireOtp);
    const sendInvite = body.sendInvite !== false;
    const reminderIntervalDays = Math.max(0, Number(body.reminderIntervalDays ?? 3) || 0);
    const maxReminders = Math.max(0, Number(body.maxReminders ?? 4) || 0);
    const purgeAfterDays = Math.max(1, Number(body.purgeAfterDays ?? config.defaultPurgeDays) || config.defaultPurgeDays);
    const dueAt = body.dueAt ? String(body.dueAt) : null;
    const clientSubject = body.clientSubject ? String(body.clientSubject).trim() : null;
    const welcomeNote = body.welcomeNote ? String(body.welcomeNote).trim() : null;

    const template = templateId ? store.getTemplate(auth.workspace.id, templateId) : undefined;
    if ((!template && !body.items) || !title || !clientName || !clientEmail.includes("@")) {
      return c.json(
        { error: "Select a template and fill in title, client name, and valid client email." },
        400
      );
    }

    let items: TemplateItemSpec[];
    try {
      items = body.items
        ? normalizeTemplateItems(body.items)
        : normalizeTemplateItems(JSON.parse(template!.items_json));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid checklist items." }, 400);
    }

    const { request, magicToken } = store.createRequest({
      workspaceId: auth.workspace.id,
      templateId: template?.id ?? null,
      title,
      clientSubject,
      welcomeNote,
      clientName,
      clientEmail,
      items,
      requireOtp,
      reminderIntervalDays,
      maxReminders,
      purgeAfterDays,
      dueAt,
      masterKey: config.masterKey,
    });

    const portalUrl = `${config.baseUrl}/c/${magicToken}`;
    if (sendInvite) {
      await sendEmailTracked({
        workspaceId: auth.workspace.id,
        requestId: request.id,
        to: clientEmail,
        message: inviteEmail({
          brand: emailBrand(auth.workspace, config.baseUrl),
          clientName,
          title,
          portalUrl,
          itemCount: items.length,
          welcomeNote,
          dueAt,
          subject: clientSubject,
        }),
        kind: "invite",
      });
      store.logAudit(auth.workspace.id, request.id, "system", "invite.sent", { to: clientEmail });
    }

    return c.json({ id: request.id, portalUrl }, 201);
  });

  app.get("/api/requests/:id", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const request = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!request) return c.json({ error: "Not found" }, 404);

    const magicToken = decryptField(config.masterKey, request.token_encrypted, request.id);
    const portalUrl = `${config.baseUrl}/c/${magicToken}`;
    const rawItems = store.listRequestItems(request.id);
    const allUploads = store.listUploadsForRequest(request.id);

    const items = rawItems.map((item) => {
      let displayValue: string | null = null;
      let isSensitiveMasked = false;
      if (item.value_encrypted) {
        const plain = decryptField(config.masterKey, item.value_encrypted, item.id);
        if (SENSITIVE_VALIDATORS.has(item.validator)) {
          displayValue = maskSensitiveValue(item.validator, plain);
          isSensitiveMasked = true;
        } else {
          displayValue = plain;
        }
      }
      return {
        id: item.id,
        position: item.position,
        section: item.section,
        label: item.label,
        help_text: item.help_text,
        kind: item.kind,
        required: item.required === 1,
        validator: item.validator,
        config: JSON.parse(item.config_json),
        status: item.status,
        displayValue,
        isSensitiveMasked,
        review_note: item.review_note,
        client_note: item.client_note_encrypted
          ? decryptField(config.masterKey, item.client_note_encrypted, `${item.id}:note`)
          : null,
        client_na: item.client_na === 1,
        updated_at: item.updated_at,
        uploads: allUploads
          .filter((u) => u.request_item_id === item.id)
          .map((u) => ({
            id: u.id,
            original_name: u.original_name,
            canonical_name: u.canonical_name,
            detected_mime: u.detected_mime,
            size_bytes: u.size_bytes,
            sha256: u.sha256,
            created_at: u.created_at,
          })),
      };
    });

    return c.json({
      request: {
        ...request,
        require_otp: request.require_otp === 1,
        reminders_paused: request.reminders_paused === 1,
        is_demo: request.is_demo === 1,
      },
      portalUrl,
      items,
      auditEvents: store.listAuditEvents(request.id),
    });
  });

  app.post("/api/requests/:id/items/:itemId/reveal", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const requestId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const req = store.getRequestById(auth.workspace.id, requestId);
    const item = req ? store.getRequestItem(requestId, itemId) : undefined;
    if (!req || !item) return c.json({ error: "Not found" }, 404);
    if (!item.value_encrypted) return c.json({ error: "No value stored" }, 404);

    store.logAudit(auth.workspace.id, requestId, "operator", "item.sensitive_revealed", {
      itemId,
      by: auth.user.email,
    });

    return c.json({
      itemId,
      value: decryptField(config.masterKey, item.value_encrypted, item.id),
    });
  });

  app.post("/api/requests/bulk-reminders", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; paused?: unknown };
    if (
      !Array.isArray(body.ids) ||
      body.ids.length === 0 ||
      body.ids.length > 200 ||
      !body.ids.every((x) => typeof x === "string" && x.length > 0) ||
      typeof body.paused !== "boolean"
    ) {
      return c.json({ error: "Provide 1 to 200 request IDs and a paused boolean." }, 400);
    }
    const updatedIds = store.setRemindersPausedBulk(auth.workspace.id, body.ids, body.paused);
    return c.json({ ok: true, updatedIds, paused: body.paused });
  });

  app.post("/api/requests/:id/toggle-reminders", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const req = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!req) return c.json({ error: "Not found" }, 404);
    const paused = req.reminders_paused === 0;
    store.toggleRemindersPaused(auth.workspace.id, req.id, paused);
    return c.json({ ok: true, reminders_paused: paused });
  });

  app.post("/api/requests/:id/remind-now", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const req = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!req) return c.json({ error: "Not found" }, 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 409);
    }

    const items = store.listRequestItems(req.id);
    const outstanding = items.filter(
      (i) => (i.required === 1 || i.status === "rejected") && (i.status === "pending" || i.status === "rejected")
    );
    if (outstanding.length === 0) {
      return c.json({ error: "No outstanding items to remind the client about." }, 400);
    }

    const cooldownMs = deps.manualReminderCooldownMs ?? DEFAULT_MANUAL_REMINDER_COOLDOWN_MS;
    if (req.last_manual_reminder_at && cooldownMs > 0) {
      const elapsed = Date.now() - Date.parse(req.last_manual_reminder_at);
      if (elapsed >= 0 && elapsed < cooldownMs) {
        const retryAfterSeconds = Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000));
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json(
          {
            error: "Reminder sent recently. Please wait before sending another.",
            retryAfterSeconds,
          },
          429
        );
      }
    }

    const magicToken = decryptField(config.masterKey, req.token_encrypted, req.id);
    const message = reminderEmail({
      brand: emailBrand(auth.workspace, config.baseUrl),
      clientName: req.client_name,
      title: req.title,
      portalUrl: `${config.baseUrl}/c/${magicToken}`,
      outstanding: outstanding.map((i) => ({
        label: i.label,
        needsRevision: i.status === "rejected",
        note: i.review_note,
      })),
    });

    await sendEmailTracked({
      workspaceId: auth.workspace.id,
      requestId: req.id,
      to: req.client_email,
      message,
      kind: "reminder",
      isDemo: req.is_demo === 1,
    });

    const updated = store.recordManualReminderSent(
      auth.workspace.id,
      req.id,
      auth.user.email,
      outstanding.length
    );

    return c.json({
      ok: true,
      reminders_sent: updated.reminders_sent,
      last_manual_reminder_at: updated.last_manual_reminder_at,
      next_reminder_at: updated.next_reminder_at,
    });
  });

  app.patch("/api/requests/:id", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const req = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!req) return c.json({ error: "Not found" }, 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as { dueAt?: unknown };
    let nextDue: string | null;
    if (body.dueAt === null || body.dueAt === "") {
      nextDue = null;
    } else if (typeof body.dueAt === "string") {
      const parsed = new Date(body.dueAt);
      if (Number.isNaN(parsed.getTime())) {
        return c.json({ error: "Invalid due date." }, 400);
      }
      nextDue = parsed.toISOString();
    } else {
      return c.json({ error: "Invalid due date." }, 400);
    }

    store.updateRequestDueAt(auth.workspace.id, req.id, nextDue, auth.user.email);
    return c.json({ ok: true, due_at: nextDue });
  });

  app.post("/api/requests/:id/items", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const req = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!req) return c.json({ error: "Not found" }, 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 409);
    }

    const raw = await c.req.json().catch(() => ({}));
    let spec: TemplateItemSpec;
    try {
      spec = normalizeTemplateItems([raw && typeof raw === "object" ? raw : {}])[0];
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid checklist item." }, 400);
    }

    const added = store.addRequestItem(auth.workspace.id, req.id, spec)!;
    return c.json(
      {
        ok: true,
        requestStatus: added.request.status,
        item: {
          id: added.item.id,
          position: added.item.position,
          section: added.item.section,
          label: added.item.label,
          help_text: added.item.help_text,
          kind: added.item.kind,
          required: added.item.required === 1,
          validator: added.item.validator,
          config: JSON.parse(added.item.config_json),
          status: added.item.status,
          displayValue: null,
          isSensitiveMasked: false,
          review_note: null,
          client_note: null,
          client_na: false,
          updated_at: added.item.updated_at,
          uploads: [],
        },
      },
      201
    );
  });

  app.post("/api/requests/:id/items/:itemId/review", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const requestId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const body = (await c.req.json().catch(() => ({}))) as {
      decision?: "approved" | "rejected";
      note?: string;
    };
    const decision = body.decision === "approved" ? "approved" : "rejected";
    const note = String(body.note || "").trim();

    const item = store.getRequestItem(requestId, itemId);
    const reqBefore = store.getRequestById(auth.workspace.id, requestId);
    if (!reqBefore || !item) return c.json({ error: "Not found" }, 404);

    const { justCompleted, request } = store.reviewItem({
      workspaceId: auth.workspace.id,
      requestId,
      itemId,
      decision,
      note,
    });

    if (decision === "rejected") {
      const magicToken = decryptField(config.masterKey, request.token_encrypted, request.id);
      const portalUrl = `${config.baseUrl}/c/${magicToken}`;
      await sendEmailTracked({
        workspaceId: auth.workspace.id,
        requestId: request.id,
        to: request.client_email,
        message: revisionEmail({
          brand: emailBrand(auth.workspace, config.baseUrl),
          clientName: request.client_name,
          title: request.title,
          itemLabel: item.label,
          note: note || "Please review and re-upload.",
          portalUrl,
        }),
        kind: "revision",
        isDemo: request.is_demo === 1,
      });
    }

    if (justCompleted) {
      await dispatchCompletionWebhook({
        store,
        workspace: auth.workspace,
        request,
        masterKey: config.masterKey,
        baseUrl: config.baseUrl,
        fetchImpl: deps.fetchImpl,
      });
    }

    return c.json({ ok: true, status: request.status, justCompleted });
  });

  app.post("/api/requests/:id/approve-all-submitted", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const requestId = c.req.param("id");
    const existing = store.getRequestById(auth.workspace.id, requestId);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const { approvedCount, justCompleted, request } = store.approveAllSubmitted(
      auth.workspace.id,
      requestId
    );

    if (justCompleted) {
      await dispatchCompletionWebhook({
        store,
        workspace: auth.workspace,
        request,
        masterKey: config.masterKey,
        baseUrl: config.baseUrl,
        fetchImpl: deps.fetchImpl,
      });
    }

    return c.json({ ok: true, approvedCount, status: request.status, justCompleted });
  });

  async function streamDecryptedUpload(
    c: import("hono").Context<AppEnv>,
    uploadId: string,
    inline: boolean
  ) {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const upload = store.getUploadForWorkspace(auth.workspace.id, uploadId);
    if (!upload) return c.json({ error: "Not found" }, 404);

    const encStream = await storage.getStream(upload.storage_key);
    const decStream = createDecryptStream(
      config.masterKey,
      encStream,
      { ivHex: upload.enc_iv, tagHex: upload.enc_tag, saltHex: upload.enc_salt },
      upload.storage_key
    );
    store.logAudit(
      auth.workspace.id,
      upload.request_id,
      "operator",
      inline ? "upload.previewed" : "upload.downloaded",
      { uploadId: upload.id, canonicalName: upload.canonical_name }
    );

    const webStream = Readable.toWeb(decStream) as unknown as ReadableStream;
    const headers: Record<string, string> = {
      "content-type": upload.detected_mime,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${upload.canonical_name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    };
    if (inline) {
      headers["content-security-policy"] = "default-src 'none'; sandbox";
    }
    return new Response(webStream, { status: 200, headers });
  }

  app.get("/api/uploads/:uploadId/download", (c) =>
    streamDecryptedUpload(c, c.req.param("uploadId"), false)
  );
  app.get("/api/uploads/:uploadId/preview", (c) =>
    streamDecryptedUpload(c, c.req.param("uploadId"), true)
  );

  app.get("/api/requests/:id/export.zip", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const request = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!request || request.status === "purged") return c.json({ error: "Not found" }, 404);

    const items = store.listRequestItems(request.id);
    const uploads = store.listUploadsForRequest(request.id);

    const zip = new ZipFile();
    const manifest = {
      request_id: request.id,
      title: request.title,
      client_name: request.client_name,
      client_email: request.client_email,
      status: request.status,
      exported_at: new Date().toISOString(),
      items: items.map((it) => ({
        section: it.section,
        label: it.label,
        kind: it.kind,
        validator: it.validator,
        status: it.status,
        value: it.value_encrypted
          ? decryptField(config.masterKey, it.value_encrypted, it.id)
          : null,
        files: uploads
          .filter((u) => u.request_item_id === it.id)
          .map((u) => ({ canonical_name: u.canonical_name, sha256: u.sha256, mime: u.detected_mime })),
      })),
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "summary.json");

    for (const u of uploads) {
      const encStream = await storage.getStream(u.storage_key);
      const decStream = createDecryptStream(
        config.masterKey,
        encStream,
        { ivHex: u.enc_iv, tagHex: u.enc_tag, saltHex: u.enc_salt },
        u.storage_key
      );
      zip.addReadStream(decStream, `files/${u.canonical_name}`, { compress: false });
    }
    zip.end();

    store.logAudit(auth.workspace.id, request.id, "operator", "request.exported_zip", {
      fileCount: uploads.length,
    });

    const filename = `${slugify(request.client_name, "client")}-${slugify(request.title, "pack")}.zip`;
    const webStream = Readable.toWeb(zip.outputStream) as unknown as ReadableStream;
    return new Response(webStream, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Templates CRUD
  // ---------------------------------------------------------------------------
  app.get("/api/templates", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const list = store.listTemplates(auth.workspace.id).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      is_builtin: t.is_builtin === 1,
      items: JSON.parse(t.items_json) as TemplateItemSpec[],
      created_at: t.created_at,
    }));
    return c.json({ templates: list, branding: publicBranding(auth.workspace) });
  });

  app.post("/api/templates/:id/duplicate", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const dup = store.duplicateTemplate(auth.workspace.id, c.req.param("id"), body.name);
    if (!dup) return c.json({ error: "Template not found" }, 404);
    return c.json(
      {
        template: {
          id: dup.id,
          name: dup.name,
          description: dup.description,
          is_builtin: dup.is_builtin === 1,
          items: JSON.parse(dup.items_json) as TemplateItemSpec[],
          created_at: dup.created_at,
        },
      },
      201
    );
  });

  app.post("/api/templates", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      items?: unknown;
    };
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    if (!name) return c.json({ error: "Template name is required." }, 400);

    try {
      const items = normalizeTemplateItems(body.items);
      const created = store.createTemplate(auth.workspace.id, name, description, items);
      return c.json(
        {
          template: {
            id: created.id,
            name: created.name,
            description: created.description,
            is_builtin: created.is_builtin === 1,
            items,
            created_at: created.created_at,
          },
        },
        201
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid template payload" }, 400);
    }
  });

  app.put("/api/templates/:id", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      items?: unknown;
    };
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    if (!name) return c.json({ error: "Template name is required." }, 400);

    try {
      const items = normalizeTemplateItems(body.items);
      const updated = store.updateTemplate(auth.workspace.id, c.req.param("id"), name, description, items);
      if (!updated) return c.json({ error: "Template not found" }, 404);
      return c.json({
        template: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          is_builtin: updated.is_builtin === 1,
          items,
          created_at: updated.created_at,
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid template payload" }, 400);
    }
  });

  app.delete("/api/templates/:id", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const result = store.deleteTemplate(auth.workspace.id, c.req.param("id"));
    if (!result.deleted) {
      return c.json({ error: result.reason || "Cannot delete template" }, result.reason?.includes("Built-in") ? 400 : 404);
    }
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Settings, Readiness, Local Email Outbox & Demo Controls
  // ---------------------------------------------------------------------------
  app.get("/api/settings", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const emailSummary = summarizeWorkspaceEmail(auth.workspace);
    return c.json({
      webhookUrl: auth.workspace.webhook_url || "",
      webhookSecret: auth.workspace.webhook_secret || "",
      branding: publicBranding(auth.workspace),
      account: {
        id: auth.user.id,
        email: auth.user.email,
        displayName: auth.user.display_name || "",
        workspaceName: auth.workspace.name,
      },
      email: emailSummary,
      readiness: {
        masterKeyConfigured: Boolean(config.masterKey && config.masterKey.byteLength === 32),
        storageBackend: config.storageBackend,
        emailBackend: emailSummary.backend,
        emailFrom: emailSummary.from,
        cronIntervalMinutes: config.cronIntervalMinutes,
        defaultPurgeDays: config.defaultPurgeDays,
        hasDemoData: store.hasDemoData(auth.workspace.id),
        storageBytes: store.getWorkspaceStorageBytes(auth.workspace.id),
        outboxCount: store.countOutboxEmails(auth.workspace.id),
      },
    });
  });

  app.put("/api/settings/branding", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      brandColor?: string | null;
      supportEmail?: string | null;
      supportPhone?: string | null;
      logoDataUrl?: string | null;
    };

    const brandColor = body.brandColor ? String(body.brandColor).trim() : null;
    if (brandColor && !isHexColor(brandColor)) {
      return c.json({ error: "Brand colour must be a hex value like #0F5243." }, 400);
    }
    const supportEmail = body.supportEmail ? String(body.supportEmail).trim().slice(0, 200) : null;
    if (supportEmail && !validateTextValue("email", supportEmail).valid) {
      return c.json({ error: "Support email is not a valid email address." }, 400);
    }
    const supportPhone = body.supportPhone ? String(body.supportPhone).trim().slice(0, 40) : null;
    if (supportPhone && !/^[+\d][\d\s()-]{5,}$/.test(supportPhone)) {
      return c.json({ error: "Support phone may only contain digits, spaces, +, ( ) and -." }, 400);
    }

    let logo: { mime: string; b64: string } | null | undefined;
    if (body.logoDataUrl === null) {
      logo = null;
    } else if (typeof body.logoDataUrl === "string") {
      const match = body.logoDataUrl.match(/^data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return c.json({ error: "Logo must be a base64 data URL." }, 400);
      const buf = Buffer.from(match[1], "base64");
      if (buf.byteLength > MAX_LOGO_BYTES) {
        return c.json({ error: "Logo must be 200 KB or smaller." }, 400);
      }
      // Trust the bytes, not the declared type. SVG is rejected because it can carry script.
      const detected = detectFileSignature(buf, "logo");
      if (!detected || !LOGO_MIMES.has(detected.mime)) {
        return c.json({ error: "Logo must be a PNG, JPEG or WebP image." }, 400);
      }
      logo = { mime: detected.mime, b64: buf.toString("base64") };
    }

    store.updateWorkspaceBranding(auth.workspace.id, { brandColor, supportEmail, supportPhone, logo });
    return c.json({ ok: true, branding: publicBranding(store.getWorkspaceById(auth.workspace.id)!) });
  });

  // Public so email clients can load it; workspace ids are unguessable and logos are not sensitive.
  app.get("/api/public/workspaces/:id/logo", (c) => {
    const ws = store.getWorkspaceById(c.req.param("id"));
    if (!ws?.logo_b64 || !ws.logo_mime) return c.json({ error: "Not found" }, 404);
    return c.body(Buffer.from(ws.logo_b64, "base64"), 200, {
      "content-type": ws.logo_mime,
      "cache-control": "public, max-age=3600",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });

  app.get("/api/validators", (c) => {
    if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ validators: listValidators() });
  });

  app.put("/api/settings/webhook", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      webhookUrl?: string;
      webhookSecret?: string;
    };
    const webhookUrl = String(body.webhookUrl || "").trim();
    const webhookSecret = String(body.webhookSecret || "").trim();

    if (webhookUrl) {
      try {
        const parsed = new URL(webhookUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("Invalid protocol");
        }
      } catch {
        return c.json({ error: "Webhook URL must be valid http or https." }, 400);
      }
    }

    store.updateWorkspaceWebhook(auth.workspace.id, webhookUrl || null, webhookSecret || null);
    return c.json({ ok: true });
  });

  app.post("/api/settings/webhook/test", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const result = await dispatchTestWebhook({
      workspace: auth.workspace,
      fetchImpl: deps.fetchImpl,
    });
    if (!result.ok) {
      return c.json(
        { ok: false, status: result.status, error: result.error || `HTTP ${result.status}` },
        400
      );
    }
    return c.json({ ok: true, status: result.status });
  });

  app.put("/api/settings/email", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      backend?: unknown;
      from?: unknown;
      replyTo?: unknown;
      smtp?: {
        host?: unknown;
        port?: unknown;
        secure?: unknown;
        user?: unknown;
        pass?: unknown;
        clearPass?: unknown;
      };
      resend?: {
        apiKey?: unknown;
      };
    };

    const backend = String(body.backend || "") as EmailBackend;
    if (backend !== "console" && backend !== "smtp" && backend !== "resend") {
      return c.json({ error: "Choose console, smtp, or resend for email delivery." }, 400);
    }

    const from = String(body.from || "").trim();
    const replyTo = String(body.replyTo || "").trim();
    if (hasCrLf(from) || hasCrLf(replyTo)) {
      return c.json({ error: "Email headers cannot contain line breaks." }, 400);
    }
    if (backend !== "console") {
      const fromAddr = extractAddress(from);
      if (!from || !validateTextValue("email", fromAddr).valid) {
        return c.json({ error: "Enter a valid sender email (e.g. Practice <hello@domain.com>)." }, 400);
      }
    } else if (from && !validateTextValue("email", extractAddress(from)).valid) {
      return c.json({ error: "Sender email format is invalid." }, 400);
    }
    if (replyTo && !validateTextValue("email", extractAddress(replyTo)).valid) {
      return c.json({ error: "Reply-to address is invalid." }, 400);
    }

    const existing = resolveWorkspaceEmail(auth.workspace, config, config.masterKey);
    let encryptedSecrets: string | null = null;

    if (backend === "smtp") {
      const host = String(body.smtp?.host || "").trim();
      const user = String(body.smtp?.user || "").trim();
      const port = Number(body.smtp?.port ?? 587);
      const secure = Boolean(body.smtp?.secure);
      if (!host || hasCrLf(host) || /\s/.test(host)) {
        return c.json({ error: "Enter a valid SMTP host." }, 400);
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return c.json({ error: "SMTP port must be between 1 and 65535." }, 400);
      }
      if (hasCrLf(user)) {
        return c.json({ error: "SMTP username cannot contain line breaks." }, 400);
      }
      const clearPass = body.smtp?.clearPass === true;
      const rawPass = typeof body.smtp?.pass === "string" ? body.smtp.pass : "";
      const pass = clearPass ? "" : rawPass.length > 0 ? rawPass : existing.smtp?.pass || "";
      const secrets: WorkspaceEmailSecrets = {
        smtpHost: host,
        smtpPort: port,
        smtpSecure: secure,
        smtpUser: user,
        smtpPass: pass,
      };
      encryptedSecrets = encryptField(
        config.masterKey,
        JSON.stringify(secrets),
        `${auth.workspace.id}:email`
      );
    } else if (backend === "resend") {
      const rawKey = typeof body.resend?.apiKey === "string" ? body.resend.apiKey.trim() : "";
      const apiKey = rawKey || existing.resendApiKey || "";
      if (!apiKey) {
        return c.json({ error: "Resend API key is required." }, 400);
      }
      if (hasCrLf(apiKey)) {
        return c.json({ error: "Resend API key cannot contain line breaks." }, 400);
      }
      const secrets: WorkspaceEmailSecrets = { resendApiKey: apiKey };
      encryptedSecrets = encryptField(
        config.masterKey,
        JSON.stringify(secrets),
        `${auth.workspace.id}:email`
      );
    }

    store.updateWorkspaceEmailConfig(auth.workspace.id, {
      emailBackend: backend,
      emailFrom: from || null,
      emailReplyTo: replyTo || null,
      emailConfigEncrypted: encryptedSecrets,
    });
    store.logAudit(auth.workspace.id, null, "operator", "settings.email_updated", {
      actorEmail: auth.user.email,
      backend,
    });
    const updated = store.getWorkspaceById(auth.workspace.id)!;
    return c.json({ ok: true, email: summarizeWorkspaceEmail(updated) });
  });

  app.post("/api/settings/email/test", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { to?: string };
    const to = String(body.to || auth.user.email).trim();
    if (!to || hasCrLf(to) || !validateTextValue("email", to).valid) {
      return c.json({ error: "Enter a valid recipient email." }, 400);
    }
    const resolved = resolveWorkspaceEmail(auth.workspace, config, config.masterKey);
    if (resolved.backend === "smtp" && !resolved.smtp?.host) {
      return c.json({ error: "Configure an SMTP host before sending a test email." }, 400);
    }
    if (resolved.backend === "resend" && !resolved.resendApiKey) {
      return c.json({ error: "Configure a Resend API key before sending a test email." }, 400);
    }
    const backendLabel =
      resolved.backend === "console"
        ? "Local Outbox"
        : resolved.backend === "smtp"
          ? `SMTP (${resolved.smtp?.host})`
          : "Resend";
    const msg = testDeliveryEmail({
      brand: emailBrand(auth.workspace, config.baseUrl),
      backendLabel,
    });
    try {
      await sendEmailTracked({
        workspace: auth.workspace,
        workspaceId: auth.workspace.id,
        requestId: null,
        to,
        message: msg,
        kind: "test",
      });
      return c.json({ ok: true, backend: resolved.backend, to });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : "Email send failed" },
        400
      );
    }
  });

  app.put("/api/account", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      displayName?: unknown;
      workspaceName?: unknown;
      email?: unknown;
    };

    if (body.workspaceName !== undefined) {
      const nextWsName = String(body.workspaceName || "").trim();
      if (!nextWsName || nextWsName.length > 100) {
        return c.json({ error: "Practice name must be between 1 and 100 characters." }, 400);
      }
      store.updateWorkspaceName(auth.workspace.id, nextWsName);
    }

    let nextDisplayName = auth.user.display_name;
    if (body.displayName !== undefined) {
      const trimmed = String(body.displayName || "").trim();
      if (trimmed.length > 100) {
        return c.json({ error: "Display name cannot exceed 100 characters." }, 400);
      }
      nextDisplayName = trimmed || null;
    }

    let nextEmail = auth.user.email;
    if (body.email !== undefined) {
      const candidate = String(body.email || "").trim().toLowerCase();
      if (!candidate || hasCrLf(candidate) || !validateTextValue("email", candidate).valid) {
        return c.json({ error: "Enter a valid email address." }, 400);
      }
      if (candidate !== auth.user.email) {
        const conflict = store.getUserByEmail(candidate);
        if (conflict && conflict.id !== auth.user.id) {
          return c.json({ error: "An account with this email already exists." }, 409);
        }
      }
      nextEmail = candidate;
    }

    store.updateUserProfile(auth.user.id, { displayName: nextDisplayName, email: nextEmail });
    const updatedUser = store.getUserById(auth.user.id)!;
    const updatedWorkspace = store.getWorkspaceById(auth.workspace.id)!;
    return c.json({
      ok: true,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        displayName: updatedUser.display_name,
      },
      workspace: sanitizeWorkspace(updatedWorkspace),
    });
  });

  app.put("/api/account/password", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!verifyPassword(currentPassword, auth.user.password_hash)) {
      return c.json({ error: "Current password is incorrect." }, 400);
    }
    if (newPassword.length < 10) {
      return c.json({ error: "New password must be at least 10 characters." }, 400);
    }
    store.updateUserPassword(auth.user.id, hashPassword(newPassword));
    const currentToken = getCookie(c, SESSION_COOKIE) || "";
    if (currentToken) {
      store.deleteOtherSessions(auth.user.id, currentToken);
    }
    store.logAudit(auth.workspace.id, null, "operator", "account.password_changed", {
      actorEmail: auth.user.email,
    });
    return c.json({ ok: true });
  });

  app.get("/api/outbox", (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const resolvedEmail = resolveWorkspaceEmail(auth.workspace, config, config.masterKey);
    return c.json({
      emailBackend: resolvedEmail.backend,
      emails: store.listOutboxEmails(auth.workspace.id, 100),
    });
  });

  app.post("/api/demo/seed", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const res = await seedDemoWorkspace({
      store,
      storage,
      workspaceId: auth.workspace.id,
      masterKey: config.masterKey,
      baseUrl: config.baseUrl,
    });
    return c.json({ ok: true, seeded: res.seeded });
  });

  app.post("/api/demo/clear", async (c) => {
    const auth = requireAuth(c);
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const { storageKeys, deletedRequests } = store.clearDemoData(auth.workspace.id);
    for (const key of storageKeys) {
      await storage.delete(key);
    }
    return c.json({ ok: true, deletedRequests, deletedFiles: storageKeys.length });
  });

  // ---------------------------------------------------------------------------
  // Client Magic-Link API (/api/client/:token)
  // ---------------------------------------------------------------------------
  function isClientVerified(
    c: import("hono").Context<AppEnv>,
    req: { id: string; require_otp: number }
  ): boolean {
    if (req.require_otp === 0) return true;
    const cookieVal = getCookie(c, `${CLIENT_COOKIE_PREFIX}${req.id}`);
    return store.hasValidClientSession(req.id, cookieVal);
  }

  app.get("/api/client/:token", (c) => {
    const token = c.req.param("token");
    const request = store.getRequestByMagicToken(token);
    if (!request) return c.json({ error: "Invalid or expired checklist link." }, 404);
    const workspace = store.getWorkspaceById(request.workspace_id);
    if (!workspace) return c.json({ error: "Not found" }, 404);

    if (!isClientVerified(c, request) && request.status !== "purged") {
      return c.json({
        requiresOtp: true,
        workspaceName: workspace.name,
        branding: publicBranding(workspace),
        request: {
          id: request.id,
          title: request.title,
          client_name: request.client_name,
          maskedEmail: maskEmail(request.client_email),
          status: request.status,
          due_at: request.due_at,
        },
      });
    }

    if (request.status !== "purged") {
      store.touchRequestOpened(request.id);
    }

    const rawItems = store.listRequestItems(request.id);
    const allUploads = store.listUploadsForRequest(request.id);
    const items = rawItems.map((item) => {
      let currentValue: string | null = null;
      let isSensitiveMasked = false;
      if (item.value_encrypted) {
        const plain = decryptField(config.masterKey, item.value_encrypted, item.id);
        if (SENSITIVE_VALIDATORS.has(item.validator)) {
          currentValue = maskSensitiveValue(item.validator, plain);
          isSensitiveMasked = true;
        } else {
          currentValue = plain;
        }
      }
      return {
        id: item.id,
        position: item.position,
        section: item.section,
        label: item.label,
        help_text: item.help_text,
        kind: item.kind,
        required: item.required === 1,
        validator: item.validator,
        validator_hint: getValidatorHint(item.validator) ?? null,
        config: JSON.parse(item.config_json),
        status: item.status,
        currentValue,
        isSensitiveMasked,
        review_note: item.review_note,
        client_note: item.client_note_encrypted
          ? decryptField(config.masterKey, item.client_note_encrypted, `${item.id}:note`)
          : null,
        client_na: item.client_na === 1,
        updated_at: item.updated_at,
        uploads: allUploads
          .filter((u) => u.request_item_id === item.id)
          .map((u) => ({
            id: u.id,
            original_name: u.original_name,
            canonical_name: u.canonical_name,
            detected_mime: u.detected_mime,
            size_bytes: u.size_bytes,
            created_at: u.created_at,
          })),
      };
    });

    return c.json({
      requiresOtp: false,
      workspaceName: workspace.name,
      branding: publicBranding(workspace),
      request: {
        id: request.id,
        title: request.title,
        client_name: request.client_name,
        client_subject: request.client_subject,
        welcome_note: request.welcome_note,
        status: request.status,
        due_at: request.due_at,
        completed_at: request.completed_at,
        purge_at: request.purge_at,
      },
      items,
    });
  });

  app.post("/api/client/:token/otp/send", async (c) => {
    const token = c.req.param("token");
    const request = store.getRequestByMagicToken(token);
    if (!request || request.status === "purged") return c.json({ error: "Not found" }, 404);
    const workspace = store.getWorkspaceById(request.workspace_id);
    if (!workspace) return c.json({ error: "Not found" }, 404);
    const { code, hash } = generateOtpCode();
    store.createOtpCode(request.id, hash, 15);

    await sendEmailTracked({
      workspaceId: request.workspace_id,
      requestId: request.id,
      to: request.client_email,
      message: otpEmail({
        brand: emailBrand(workspace, config.baseUrl),
        clientName: request.client_name,
        title: request.title,
        code,
      }),
      kind: "otp",
      isDemo: request.is_demo === 1,
    });
    store.logAudit(request.workspace_id, request.id, "client", "otp.sent", {});
    return c.json({ ok: true, maskedEmail: maskEmail(request.client_email) });
  });

  app.post("/api/client/:token/otp/verify", async (c) => {
    const token = c.req.param("token");
    const request = store.getRequestByMagicToken(token);
    if (!request || request.status === "purged") return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const submitted = String(body.code || "");
    const active = store.getActiveOtpCode(request.id);

    if (!active || active.expires_at <= new Date().toISOString()) {
      return c.json({ error: "Verification code expired. Request a new code." }, 400);
    }
    if (active.attempts >= 5) {
      return c.json({ error: "Too many attempts. Request a new code." }, 429);
    }
    if (!verifyOtpCode(submitted, active.code_hash)) {
      store.incrementOtpAttempts(active.id);
      return c.json({ error: "Incorrect 6-digit code." }, 400);
    }

    store.markOtpVerified(active.id);
    const clientSessToken = store.createClientSession(request.id, 12);
    setCookie(c, `${CLIENT_COOKIE_PREFIX}${request.id}`, clientSessToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookie,
      path: "/api/client/",
      maxAge: 12 * 3600,
    });
    store.logAudit(request.workspace_id, request.id, "client", "otp.verified", {});
    return c.json({ ok: true });
  });

  app.post("/api/client/:token/items/:itemId", async (c) => {
    const token = c.req.param("token");
    const itemId = c.req.param("itemId");
    const request = store.getRequestByMagicToken(token);
    if (!request || request.status === "purged" || request.status === "completed") {
      return c.json({ error: "Checklist is closed." }, 403);
    }
    if (!isClientVerified(c, request)) {
      return c.json({ error: "Email verification required." }, 401);
    }

    const item = store.getRequestItem(request.id, itemId);
    if (!item) return c.json({ error: "Item not found" }, 404);
    if (item.status === "approved") {
      return c.json({ error: "Approved items are locked and cannot be modified." }, 409);
    }

    const workspace = store.getWorkspaceById(request.workspace_id)!;

    if (item.kind === "checkbox") {
      const body = (await c.req.json().catch(() => ({}))) as { checked?: boolean | string };
      const isChecked = body.checked === true || body.checked === "1" || body.checked === "true";
      if (!isChecked) {
        return c.json({ error: "Please confirm the declaration checkbox." }, 400);
      }
      store.saveTextOrCheckboxSubmission(
        item.id,
        request.id,
        encryptField(config.masterKey, "confirmed", item.id)
      );
      store.logAudit(request.workspace_id, request.id, "client", "item.submitted", {
        itemId: item.id,
        kind: "checkbox",
      });
      const updated = store.getRequestItem(request.id, item.id)!;
      const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
      return c.json({
        ok: true,
        requestStatus: reqAfter.status,
        item: { status: updated.status, currentValue: "confirmed", isSensitiveMasked: false },
      });
    }

    if (item.kind === "text" || item.kind === "textarea") {
      const body = (await c.req.json().catch(() => ({}))) as { value?: string };
      const rawValue = String(body.value || "");
      const check = validateTextValue(item.validator, rawValue);
      if (!check.valid || !check.normalised) {
        return c.json({ error: check.error || "Invalid value" }, 400);
      }
      store.saveTextOrCheckboxSubmission(
        item.id,
        request.id,
        encryptField(config.masterKey, check.normalised, item.id)
      );
      store.logAudit(request.workspace_id, request.id, "client", "item.submitted", {
        itemId: item.id,
        kind: item.kind,
        validator: item.validator,
      });
      const updated = store.getRequestItem(request.id, item.id)!;
      const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
      const isSensitiveMasked = SENSITIVE_VALIDATORS.has(item.validator);
      return c.json({
        ok: true,
        requestStatus: reqAfter.status,
        item: {
          status: updated.status,
          currentValue: isSensitiveMasked
            ? maskSensitiveValue(item.validator, check.normalised)
            : check.normalised,
          isSensitiveMasked,
        },
      });
    }

    // File upload flow
    const formData = await c.req.formData();
    const rawFiles = formData.getAll("file").filter((v): v is File => v instanceof File && v.size > 0);
    if (rawFiles.length === 0) {
      return c.json({ error: "Please choose at least one file to upload." }, 400);
    }

    const cfg = JSON.parse(item.config_json) as {
      allowedGroups?: string[];
      maxFileMb?: number;
      slug?: string;
    };
    const maxBytes = (cfg.maxFileMb ?? 20) * 1024 * 1024;
    const allowedMimes = resolveAllowedMimes(cfg.allowedGroups);
    const currentStorage = store.getWorkspaceStorageBytes(workspace.id);
    let addedBytes = 0;
    const savedUploads = [];

    for (const file of rawFiles) {
      if (file.size > maxBytes) {
        return c.json(
          { error: `"${file.name}" exceeds max size of ${cfg.maxFileMb ?? 20} MB.` },
          400
        );
      }
      if (
        workspace.max_storage_bytes > 0 &&
        currentStorage + addedBytes + file.size > workspace.max_storage_bytes
      ) {
        return c.json({ error: "Workspace storage limit reached." }, 403);
      }

      const buf = Buffer.from(await file.arrayBuffer());
      const detected = detectFileSignature(buf, file.name);
      if (!detected || !allowedMimes.includes(detected.mime)) {
        return c.json(
          {
            error: `"${file.name}" failed file-type verification. Upload an allowed PDF, image, spreadsheet, or document.`,
          },
          400
        );
      }

      const seq = store.countUploadsForItem(item.id) + 1;
      const clientSlug = slugify(request.client_name, "client");
      const itemSlug = slugify(cfg.slug || item.label, "doc");
      const canonicalName = `${clientSlug}_${itemSlug}_${String(seq).padStart(2, "0")}.${detected.ext}`;
      const storageKey = `${workspace.id}/${request.id}/${item.id}/${Date.now()}_${canonicalName}.enc`;

      const { ciphertext, meta } = encryptBuffer(config.masterKey, buf, storageKey);
      await storage.put(storageKey, ciphertext);

      const uploadRow = store.addUpload({
        itemId: item.id,
        requestId: request.id,
        originalName: file.name.slice(0, 200),
        canonicalName,
        detectedMime: detected.mime,
        sizeBytes: meta.sizeBytes,
        storageKey,
        ivHex: meta.ivHex,
        tagHex: meta.tagHex,
        saltHex: meta.saltHex,
        sha256Hex: meta.sha256Hex,
      });
      savedUploads.push({
        id: uploadRow.id,
        original_name: uploadRow.original_name,
        canonical_name: uploadRow.canonical_name,
        detected_mime: uploadRow.detected_mime,
        size_bytes: uploadRow.size_bytes,
        created_at: uploadRow.created_at,
      });
      addedBytes += meta.sizeBytes;
    }

    store.logAudit(request.workspace_id, request.id, "client", "item.files_uploaded", {
      itemId: item.id,
      count: rawFiles.length,
    });
    const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
    return c.json({
      ok: true,
      requestStatus: reqAfter.status,
      uploads: savedUploads,
    });
  });

  /** Shared guard for client writes: open request, verified client, item not locked. */
  function resolveClientWrite(c: import("hono").Context<AppEnv>, itemId: string) {
    const request = store.getRequestByMagicToken(c.req.param("token") ?? "");
    if (!request || request.status === "purged" || request.status === "completed") {
      return { error: c.json({ error: "Checklist is closed." }, 403) };
    }
    if (!isClientVerified(c, request)) {
      return { error: c.json({ error: "Email verification required." }, 401) };
    }
    const item = store.getRequestItem(request.id, itemId);
    if (!item) return { error: c.json({ error: "Item not found" }, 404) };
    if (item.status === "approved") {
      return { error: c.json({ error: "Approved items are locked and cannot be modified." }, 409) };
    }
    return { request, item };
  }

  app.put("/api/client/:token/items/:itemId/note", async (c) => {
    const resolved = resolveClientWrite(c, c.req.param("itemId"));
    if (resolved.error) return resolved.error;
    const { request, item } = resolved;
    const body = (await c.req.json().catch(() => ({}))) as { note?: string; notApplicable?: boolean };
    const note = String(body.note ?? "").trim();
    const notApplicable = body.notApplicable === true;
    if (note.length > MAX_CLIENT_NOTE_CHARS) {
      return c.json({ error: `Notes are limited to ${MAX_CLIENT_NOTE_CHARS} characters.` }, 400);
    }
    if (notApplicable && !note) {
      return c.json({ error: "Tell us briefly why this does not apply." }, 400);
    }
    store.setClientNote(
      item.id,
      request.id,
      note ? encryptField(config.masterKey, note, `${item.id}:note`) : null,
      notApplicable
    );
    store.logAudit(request.workspace_id, request.id, "client", notApplicable ? "item.marked_na" : "item.note_saved", {
      itemId: item.id,
    });
    const updated = store.getRequestItem(request.id, item.id)!;
    const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
    return c.json({
      ok: true,
      requestStatus: reqAfter.status,
      item: { status: updated.status, client_note: note || null, client_na: updated.client_na === 1 },
    });
  });

  app.delete("/api/client/:token/uploads/:uploadId", async (c) => {
    const request = store.getRequestByMagicToken(c.req.param("token"));
    const upload = request ? store.getUploadForRequest(request.id, c.req.param("uploadId")) : undefined;
    if (!request || !upload) return c.json({ error: "File not found" }, 404);
    const resolved = resolveClientWrite(c, upload.request_item_id);
    if (resolved.error) return resolved.error;

    const removed = store.deleteUpload(request.id, upload.id);
    if (removed) await storage.delete(removed.storageKey);
    store.logAudit(request.workspace_id, request.id, "client", "item.file_removed", {
      itemId: upload.request_item_id,
      originalName: upload.original_name,
    });
    const updated = store.getRequestItem(request.id, upload.request_item_id)!;
    const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
    return c.json({ ok: true, requestStatus: reqAfter.status, item: { status: updated.status } });
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // ---------------------------------------------------------------------------
  // Compiled Vite SPA Static Assets + Deep-Link Fallback
  // ---------------------------------------------------------------------------
  if (fs.existsSync(clientDistDir)) {
    app.use(
      "/*",
      serveStatic({
        root: clientDistDir,
        onFound: (filePath, c) => {
          const normalized = filePath.replace(/\\/g, "/");
          if (normalized.includes("/assets/")) {
            c.header("Cache-Control", "public, max-age=31536000, immutable");
          } else if (normalized.endsWith("/index.html")) {
            c.header("Cache-Control", "no-cache");
          }
        },
      })
    );
  }

  app.get("*", (c) => {
    const indexPath = path.join(clientDistDir, "index.html");
    if (!fs.existsSync(indexPath)) {
      return c.text("GatherGate frontend bundle not built. Run npm run build.", 503);
    }
    return c.body(fs.readFileSync(indexPath), 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
  });

  return { app, store };
}
