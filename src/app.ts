import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import {
  SENSITIVE_DEFAULT_PURGE_DAYS,
  type AppConfig,
  type EmailBackend,
} from "./config.js";
import {
  addDaysIso,
  ClientWriteConflictError,
  SetupAlreadyCompletedError,
  slugify,
  Store,
  type ApiKeyRow,
  type RequestItemRow,
  type RequestRow,
  type UploadRow,
  type UserRow,
  type WebhookDeliveryRow,
  type WebhookDeliveryStatus,
  type WorkspaceRow,
} from "./db/queries.js";
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
import { handleMcpJsonRpc } from "./mcp/server.js";
import {
  attemptWebhookDelivery,
  buildWebhookEventPayload,
  dispatchTestWebhook,
  dispatchWebhookEvent,
  MAX_WEBHOOK_ATTEMPTS,
  replayWebhookDelivery,
  resolveWebhookSecret,
  type WebhookEventType,
} from "./jobs/webhook.js";
import {
  API_KEY_PREFIX,
  generateApiKey,
  generateOtpCode,
  hashPassword,
  normalizeApiKeyScopes,
  parseApiKeyScopesJson,
  verifyOtpCode,
  verifyPassword,
  type ApiKeyScope,
} from "./security/auth.js";
import {
  createDecryptStream,
  decryptBuffer,
  decryptField,
  encryptBuffer,
  encryptField,
  generateId,
  safeEqualHex,
  sha256Hex,
} from "./security/crypto.js";
import { detectFileSignature, resolveAllowedMimes } from "./security/magic-bytes.js";
import { extractClientIp, RateLimiter } from "./security/rate-limit.js";
import {
  assertPublicHostname,
  isPrivateOrLocalHost,
  resolvePublicHostname,
  validateWebhookEndpoint,
  type LookupAllFn,
} from "./security/ssrf.js";
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
const MAX_TEXT_ITEM_CHARS = 2000;
const MAX_TEXTAREA_ITEM_CHARS = 20_000;
const MAX_PASSWORD_CHARS = 256;
const MAX_FILES_PER_UPLOAD = 10;
const MAX_ITEM_FILE_MB = 50;
const MAX_ACTIVE_API_KEYS = 50;
const DEFAULT_MANUAL_REMINDER_COOLDOWN_MS = 15 * 60_000;
const MULTI_TENANT_SMTP_PORTS = new Set([25, 465, 587, 2525]);

function formatApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: parseApiKeyScopesJson(row.scopes_json),
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

function formatWebhookDelivery(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    request_id: row.request_id,
    event: row.event,
    target_url: row.target_url,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_status_code: row.last_status_code,
    last_error: row.last_error,
    next_attempt_at: row.next_attempt_at,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isValidEmailAddress(email: string): boolean {
  return Boolean(email && !hasCrLf(email) && !/[,\s;<>]/.test(email) && validateTextValue("email", email).valid);
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function decryptStoredUpload(
  storage: StorageAdapter,
  masterKey: Buffer,
  upload: UploadRow
): Promise<Buffer> {
  const encStream = await storage.getStream(upload.storage_key);
  const ciphertext = await readStreamToBuffer(encStream);
  return decryptBuffer(
    masterKey,
    ciphertext,
    {
      version: upload.enc_version,
      ivHex: upload.enc_iv,
      tagHex: upload.enc_tag,
      saltHex: upload.enc_salt,
    },
    upload.storage_key
  );
}

interface AppEnv {
  Variables: {
    auth?: { user: UserRow; workspace: WorkspaceRow };
  };
}

export type RateLimitKey =
  | "otpSendToken"
  | "otpSendIp"
  | "otpVerifyToken"
  | "otpVerifyIp"
  | "uploadToken"
  | "uploadIp"
  | "loginIp"
  | "loginAccount"
  | "signupIp"
  | "setupIp"
  | "settingsTest"
  | "apiKey"
  | "apiAuthIp";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

const DEFAULT_RATE_LIMITS: Record<RateLimitKey, RateLimitRule> = {
  otpSendToken: { limit: 5, windowMs: 15 * 60_000 },
  otpSendIp: { limit: 15, windowMs: 15 * 60_000 },
  otpVerifyToken: { limit: 10, windowMs: 15 * 60_000 },
  otpVerifyIp: { limit: 30, windowMs: 15 * 60_000 },
  uploadToken: { limit: 30, windowMs: 15 * 60_000 },
  uploadIp: { limit: 60, windowMs: 15 * 60_000 },
  loginIp: { limit: 20, windowMs: 15 * 60_000 },
  loginAccount: { limit: 20, windowMs: 15 * 60_000 },
  signupIp: { limit: 5, windowMs: 15 * 60_000 },
  setupIp: { limit: 10, windowMs: 15 * 60_000 },
  settingsTest: { limit: 10, windowMs: 15 * 60_000 },
  apiKey: { limit: 120, windowMs: 60_000 },
  apiAuthIp: { limit: 30, windowMs: 15 * 60_000 },
};

export interface GatherGateAppDeps {
  config: AppConfig;
  db: DatabaseSync;
  storage: StorageAdapter;
  email: EmailAdapter;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  clientDistDir?: string;
  manualReminderCooldownMs?: number;
  now?: () => number;
  rateLimits?: Partial<Record<RateLimitKey, RateLimitRule>>;
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

function acceptsApplicationJson(acceptHeader: string): boolean {
  let bestSpecificity = 0;
  let bestQuality = 0;
  for (const rawRange of acceptHeader.split(",")) {
    const parts = rawRange.split(";").map((p) => p.trim()).filter(Boolean);
    const media = (parts[0] || "").toLowerCase();
    const specificity =
      media === "application/json" ? 3 : media === "application/*" ? 2 : media === "*/*" ? 1 : 0;
    if (specificity === 0) continue;

    let q = 1;
    for (const param of parts.slice(1)) {
      const m = param.match(/^q\s*=\s*([0-9.]+)$/i);
      if (m) {
        const parsed = Number(m[1]);
        q = Number.isFinite(parsed) ? parsed : 0;
        break;
      }
    }
    if (specificity > bestSpecificity || (specificity === bestSpecificity && q > bestQuality)) {
      bestSpecificity = specificity;
      bestQuality = q;
    }
  }
  return bestSpecificity > 0 && bestQuality > 0;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isAllowedMcpOrigin(originHeader: string, baseUrl: string, multiTenant: boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  if (parsed.origin !== originHeader) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.origin === parsedBase.origin) return true;
  if (!multiTenant && isLoopbackHost(parsedBase.hostname) && isLoopbackHost(parsed.hostname)) {
    return true;
  }
  return false;
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
      maxFileMb:
        typeof item.maxFileMb === "number" && item.maxFileMb > 0
          ? Math.min(MAX_ITEM_FILE_MB, Math.max(1, Math.floor(item.maxFileMb)))
          : 20,
      multiple: Boolean(item.multiple),
      slug: item.slug ? slugify(item.slug) : slugify(label, `item-${idx + 1}`),
    };
  });
}

export function createApp(deps: GatherGateAppDeps) {
  const { config, storage, email } = deps;
  const store = new Store(deps.db);
  const app = new Hono<AppEnv>();
  const secureCookie = /^https:\/\//i.test(config.baseUrl);
  const clientDistDir = deps.clientDistDir ?? resolveDefaultClientDistDir();
  const nowFn = deps.now ?? (() => Date.now());
  const limiter = new RateLimiter(nowFn);
  const limits = { ...DEFAULT_RATE_LIMITS, ...(deps.rateLimits ?? {}) };

  function enforceRateLimit(
    c: import("hono").Context<AppEnv>,
    checks: Array<{ key: string; bucket: RateLimitKey }>,
    message: string
  ) {
    for (const check of checks) {
      const rule = limits[check.bucket];
      const res = limiter.check(`${check.bucket}:${check.key}`, rule.limit, rule.windowMs);
      if (!res.allowed) {
        c.header("Retry-After", String(res.retryAfterSeconds));
        return c.json({ error: message, retryAfterSeconds: res.retryAfterSeconds }, 429);
      }
    }
    return null;
  }

  // Tiered request body limits before parsing JSON or multipart payloads.
  const uploadLimit = bodyLimit({
    maxSize: (MAX_ITEM_FILE_MB + 5) * 1024 * 1024,
    onError: (c) => c.json({ error: "Request payload too large." }, 413),
  });
  const brandingLimit = bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: "Branding payload too large." }, 413),
  });
  const defaultJsonLimit = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: "Request payload too large." }, 413),
  });
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      return next();
    }
    if (/^\/api\/client\/[^/]+\/items\/[^/]+$/.test(c.req.path)) {
      return uploadLimit(c, next);
    }
    if (c.req.path === "/api/settings/branding") {
      return brandingLimit(c, next);
    }
    return defaultJsonLimit(c, next);
  });

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
    if (
      ((c.req.path.startsWith("/api/") && !c.req.path.startsWith("/api/public/")) ||
        c.req.path === "/mcp") &&
      !c.res.headers.has("cache-control")
    ) {
      c.header("Cache-Control", "no-store");
    }
  });

  const inFlightReminders = new Set<string>();

  // Same-site CSRF defense-in-depth on cookie-authenticated operator mutations.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      method !== "OPTIONS" &&
      !c.req.path.startsWith("/api/client/") &&
      !c.req.header("authorization")?.trim() &&
      Boolean(getCookie(c, SESSION_COOKIE))
    ) {
      const originHeader = c.req.header("origin")?.trim();
      if (originHeader) {
        if (!isAllowedMcpOrigin(originHeader, config.baseUrl, config.multiTenant)) {
          return c.json({ error: "Cross-origin request blocked." }, 403);
        }
      } else {
        const fetchSite = c.req.header("sec-fetch-site")?.trim().toLowerCase();
        if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
          return c.json({ error: "Cross-origin request blocked." }, 403);
        }
      }
    }
    return next();
  });

  app.use("/mcp", async (c, next) => {
    const originHeader = c.req.header("origin")?.trim();
    if (originHeader && !isAllowedMcpOrigin(originHeader, config.baseUrl, config.multiTenant)) {
      c.header("Vary", "Origin");
      return c.json({ error: "Forbidden Origin header." }, 403);
    }
    const maybeRes = c.req.method === "POST" ? await defaultJsonLimit(c, next) : await next();
    const target = maybeRes instanceof Response ? maybeRes : c.res;
    if (originHeader && target) {
      target.headers.set("Access-Control-Allow-Origin", originHeader);
      target.headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version, WWW-Authenticate");
      target.headers.set("Vary", "Origin");
    }
    return maybeRes instanceof Response ? maybeRes : undefined;
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "gathergate" }));

  type AuthActor =
    | {
        kind: "session";
        user: UserRow;
        workspace: WorkspaceRow;
        actor: "operator";
        actorLabel: string;
      }
    | {
        kind: "api_key";
        apiKey: ApiKeyRow;
        scopes: Set<ApiKeyScope>;
        workspace: WorkspaceRow;
        actor: "api_key";
        actorLabel: string;
      };

  function getSessionAuth(c: import("hono").Context<AppEnv>) {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    return store.getUserBySessionToken(token);
  }

  function resolveScopedAuth(
    c: import("hono").Context<AppEnv>,
    requiredScope?: ApiKeyScope
  ): { auth: AuthActor; error?: undefined } | { auth?: undefined; error: Response } {
    const authHeader = c.req.header("authorization")?.trim();
    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(\S+)$/i);
      const rawKey = match?.[1] ?? "";
      const ip = extractClientIp(c, config.trustProxy);

      if (!rawKey || !rawKey.startsWith(API_KEY_PREFIX)) {
        const limited = enforceRateLimit(
          c,
          [{ bucket: "apiAuthIp", key: ip }],
          "Too many failed API authentication attempts. Please wait and try again."
        );
        if (limited) return { error: limited };
        return { error: c.json({ error: "Invalid API key." }, 401) };
      }

      const keyHash = sha256Hex(rawKey);
      const row = store.getApiKeyByHash(keyHash);
      const nowMs = nowFn();
      const nowIso = new Date(nowMs).toISOString();
      if (
        !row ||
        !safeEqualHex(keyHash, row.key_hash) ||
        row.revoked_at ||
        (row.expires_at && row.expires_at <= nowIso)
      ) {
        const limited = enforceRateLimit(
          c,
          [{ bucket: "apiAuthIp", key: ip }],
          "Too many failed API authentication attempts. Please wait and try again."
        );
        if (limited) return { error: limited };
        return { error: c.json({ error: "Invalid or revoked API key." }, 401) };
      }

      const workspace = store.getWorkspaceById(row.workspace_id);
      if (!workspace) {
        return { error: c.json({ error: "Invalid or revoked API key." }, 401) };
      }

      const keyLimited = enforceRateLimit(
        c,
        [{ bucket: "apiKey", key: row.id }],
        "API key rate limit exceeded. Please slow down and try again."
      );
      if (keyLimited) return { error: keyLimited };

      if (!requiredScope) {
        return { error: c.json({ error: "This endpoint requires an interactive operator session." }, 403) };
      }

      const scopes = new Set(parseApiKeyScopesJson(row.scopes_json));
      if (!scopes.has(requiredScope)) {
        return {
          error: c.json(
            { error: `API key lacks required scope "${requiredScope}".`, requiredScope },
            403
          ),
        };
      }

      if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) >= 60_000) {
        store.touchApiKeyLastUsed(row.id, nowIso);
      }

      return {
        auth: {
          kind: "api_key",
          apiKey: row,
          scopes,
          workspace,
          actor: "api_key",
          actorLabel: `api_key:${row.id}`,
        },
      };
    }

    const session = getSessionAuth(c);
    if (!session) return { error: c.json({ error: "Unauthorized" }, 401) };
    return {
      auth: {
        kind: "session",
        user: session.user,
        workspace: session.workspace,
        actor: "operator",
        actorLabel: session.user.email,
      },
    };
  }

  function requireSessionOnly(
    c: import("hono").Context<AppEnv>
  ): { user: UserRow; workspace: WorkspaceRow; error?: undefined } | { user?: undefined; workspace?: undefined; error: Response } {
    const res = resolveScopedAuth(c, undefined);
    if (res.error) return { error: res.error };
    if (res.auth.kind !== "session") {
      return { error: c.json({ error: "This endpoint requires an interactive operator session." }, 403) };
    }
    return { user: res.auth.user, workspace: res.auth.workspace };
  }

  async function emitWebhookSafe(params: {
    workspace: WorkspaceRow;
    request: RequestRow;
    event: WebhookEventType;
    item?: RequestItemRow;
  }): Promise<string | undefined> {
    if (!params.workspace.webhook_url?.trim()) return undefined;
    try {
      await dispatchWebhookEvent({
        store,
        workspace: params.workspace,
        request: params.request,
        event: params.event,
        item: params.item,
        masterKey: config.masterKey,
        baseUrl: config.baseUrl,
        multiTenant: config.multiTenant,
        fetchImpl: deps.fetchImpl,
        lookupImpl: deps.lookupImpl,
        nowMs: nowFn(),
      });
      return undefined;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[GatherGate Webhook] failed to enqueue ${params.event}:`, err);
      return config.multiTenant ? "Completion webhook could not be queued." : detail;
    }
  }

  function summarizeWorkspaceEmail(ws: WorkspaceRow) {
    const resolved = resolveWorkspaceEmail(ws, config, config.masterKey);
    if (config.multiTenant && resolved.source === "env") {
      return {
        source: resolved.source,
        backend: resolved.backend,
        from: resolved.from,
        replyTo: "",
        smtp: {
          host: "",
          port: 587,
          secure: false,
          user: "",
          hasPass: false,
        },
        resend: {
          hasApiKey: false,
        },
      };
    }
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
      let pinnedAddresses: Array<{ address: string; family: 4 | 6 }> | undefined;
      if (config.multiTenant && resolved.backend === "smtp" && resolved.smtp?.host) {
        const dnsRes = await resolvePublicHostname(resolved.smtp.host, deps.lookupImpl);
        if (!dnsRes.ok) {
          throw new Error("SMTP host must resolve to a public address in multi-tenant mode.");
        }
        pinnedAddresses = dnsRes.addresses;
      }
      const adapter = createEmailAdapterFromOptions({
        backend: resolved.backend,
        from: resolved.from,
        resendApiKey: resolved.resendApiKey,
        smtp: resolved.smtp,
        pinnedAddresses,
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
    const auth = needsSetup ? null : getSessionAuth(c);
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
        masterKeyAutoGenerated: auth ? config.masterKeySource === "file" : false,
        hasDemoData: auth ? store.hasDemoData(auth.workspace.id) : false,
        outboxCount: auth ? store.countOutboxEmails(auth.workspace.id) : 0,
        awaitingReviewCount: auth ? store.countAwaitingReview(auth.workspace.id) : 0,
      },
    });
  });

  app.post("/api/setup", async (c) => {
    const ip = extractClientIp(c, config.trustProxy);
    const limited = enforceRateLimit(
      c,
      [{ bucket: "setupIp", key: ip }],
      "Too many setup attempts. Please wait and try again."
    );
    if (limited) return limited;

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

    if (
      !workspaceName ||
      hasCrLf(workspaceName) ||
      !isValidEmailAddress(userEmail) ||
      password.length < 10 ||
      password.length > MAX_PASSWORD_CHARS
    ) {
      return c.json(
        { error: "Provide workspace name, valid email, and password (10 to 256 characters)." },
        400
      );
    }

    let created: { user: UserRow; workspace: WorkspaceRow };
    try {
      created = store.createInitialWorkspaceWithUser({
        workspaceName,
        email: userEmail,
        passwordHash: hashPassword(password),
        plan: config.multiTenant ? "pro" : "self_hosted",
        maxActiveRequests: 0,
        maxStorageBytes: 0,
      });
    } catch (err) {
      if (err instanceof SetupAlreadyCompletedError || String(err).includes("UNIQUE")) {
        return c.json({ error: "Setup has already been completed." }, 409);
      }
      throw err;
    }
    const { user, workspace } = created;

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
    const ip = extractClientIp(c, config.trustProxy);
    const ipLimited = enforceRateLimit(
      c,
      [{ bucket: "loginIp", key: ip }],
      "Too many sign-in attempts. Please wait and try again."
    );
    if (ipLimited) return ipLimited;

    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    const userEmail = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (password.length > MAX_PASSWORD_CHARS) {
      return c.json({ error: "Invalid email or password." }, 401);
    }
    if (userEmail) {
      const acctLimited = enforceRateLimit(
        c,
        [{ bucket: "loginAccount", key: userEmail }],
        "Too many sign-in attempts. Please wait and try again."
      );
      if (acctLimited) return acctLimited;
    }
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
    const ip = extractClientIp(c, config.trustProxy);
    const limited = enforceRateLimit(
      c,
      [{ bucket: "signupIp", key: ip }],
      "Too many signup attempts. Please wait and try again."
    );
    if (limited) return limited;

    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceName?: string;
      email?: string;
      password?: string;
    };
    const workspaceName = String(body.workspaceName || "").trim();
    const userEmail = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (
      !workspaceName ||
      hasCrLf(workspaceName) ||
      !isValidEmailAddress(userEmail) ||
      password.length < 10 ||
      password.length > MAX_PASSWORD_CHARS
    ) {
      return c.json(
        { error: "Provide workspace name, valid email, and password (10 to 256 characters)." },
        400
      );
    }
    if (store.getUserByEmail(userEmail)) {
      return c.json({ error: "An account with this email already exists." }, 409);
    }

    let created: { user: UserRow; workspace: WorkspaceRow };
    try {
      created = store.createWorkspaceWithUser({
        workspaceName,
        email: userEmail,
        passwordHash: hashPassword(password),
        plan: "free",
        maxActiveRequests: config.freeMaxActiveRequests,
        maxStorageBytes: config.freeMaxStorageBytes,
      });
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        return c.json({ error: "An account with this email already exists." }, 409);
      }
      throw err;
    }
    const { user, workspace } = created;
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
    const resolved = resolveScopedAuth(c, "requests:read");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
    return c.json({ clients: store.listClients(auth.workspace.id) });
  });

  app.get("/api/requests", (c) => {
    const resolved = resolveScopedAuth(c, "requests:read");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
    const canExposePortalUrl = auth.kind === "session" || auth.scopes.has("requests:write");

    const rows = store.listRequests(auth.workspace.id);
    const enriched = rows.map((r) => {
      const magicToken =
        !canExposePortalUrl || r.status === "purged" || !r.token_encrypted
          ? ""
          : decryptField(config.masterKey, r.token_encrypted, r.id);
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
        portal_url: magicToken ? `${config.baseUrl}/c/${magicToken}` : "",
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
      demoPortalUrl: canExposePortalUrl ? (demoCandidate?.portal_url || null) : null,
    });
  });

  app.post("/api/requests", async (c) => {
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;

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

    const templateId = String(body.templateId || "");
    const title = String(body.title || "").trim();
    const clientName = String(body.clientName || "").trim();
    const clientEmail = String(body.clientEmail || "").trim().toLowerCase();
    const requireOtp = Boolean(body.requireOtp);
    const sendInvite = body.sendInvite !== false;
    const rawInterval = Number(body.reminderIntervalDays ?? 3);
    const reminderIntervalDays = Number.isFinite(rawInterval)
      ? Math.min(90, Math.max(0, Math.floor(rawInterval)))
      : 3;
    const rawMaxRem = Number(body.maxReminders ?? 4);
    const maxReminders = Number.isFinite(rawMaxRem) ? Math.min(20, Math.max(0, Math.floor(rawMaxRem))) : 4;
    let dueAt: string | null = null;
    if (body.dueAt !== undefined && body.dueAt !== null && String(body.dueAt).trim() !== "") {
      const parsedDue = new Date(String(body.dueAt));
      if (Number.isNaN(parsedDue.getTime())) {
        return c.json({ error: "Invalid due date." }, 400);
      }
      dueAt = parsedDue.toISOString();
    }
    const clientSubject = body.clientSubject ? String(body.clientSubject).trim() : null;
    const welcomeNote = body.welcomeNote ? String(body.welcomeNote).trim() : null;

    const template = templateId ? store.getTemplate(auth.workspace.id, templateId) : undefined;
    if (
      (!template && !body.items) ||
      !title ||
      hasCrLf(title) ||
      !clientName ||
      hasCrLf(clientName) ||
      (clientSubject && hasCrLf(clientSubject)) ||
      !isValidEmailAddress(clientEmail)
    ) {
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

    const hasSensitiveItems = items.some((i) => SENSITIVE_VALIDATORS.has(i.validator));
    const defaultPurge = hasSensitiveItems
      ? Math.min(config.defaultPurgeDays, SENSITIVE_DEFAULT_PURGE_DAYS)
      : config.defaultPurgeDays;
    const hasExplicitPurge =
      body.purgeAfterDays !== undefined &&
      body.purgeAfterDays !== null &&
      String(body.purgeAfterDays).trim() !== "";
    const purgeAfterDays = hasExplicitPurge
      ? Math.max(1, Math.min(365, Math.floor(Number(body.purgeAfterDays)) || defaultPurge))
      : defaultPurge;

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
      actor: auth.actor,
      actorBy: auth.actorLabel,
    });

    const portalUrl = `${config.baseUrl}/c/${magicToken}`;
    let inviteError: string | undefined;
    if (sendInvite) {
      try {
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
      } catch (err) {
        inviteError = config.multiTenant
          ? "Invite email failed to send. Check your outbound email settings."
          : err instanceof Error
            ? err.message
            : "Invite email failed to send.";
        store.logAudit(auth.workspace.id, request.id, "system", "invite.failed", {
          to: clientEmail,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ id: request.id, portalUrl, ...(inviteError ? { inviteError } : {}) }, 201);
  });

  app.get("/api/requests/:id", (c) => {
    const resolved = resolveScopedAuth(c, "requests:read");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
    const canExposePortalUrl = auth.kind === "session" || auth.scopes.has("requests:write");
    const request = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!request) return c.json({ error: "Not found" }, 404);

    const magicToken =
      !canExposePortalUrl || request.status === "purged" || !request.token_encrypted
        ? ""
        : decryptField(config.masterKey, request.token_encrypted, request.id);
    const portalUrl = magicToken ? `${config.baseUrl}/c/${magicToken}` : "";
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

    const { token_hash: _tokenHash, token_encrypted: _tokenEncrypted, ...safeRequest } = request;
    return c.json({
      request: {
        ...safeRequest,
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
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
    const updatedIds = store.setRemindersPausedBulk(
      auth.workspace.id,
      body.ids,
      body.paused,
      auth.actor,
      auth.actorLabel
    );
    return c.json({ ok: true, updatedIds, paused: body.paused });
  });

  app.post("/api/requests/:id/toggle-reminders", (c) => {
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
    const req = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!req) return c.json({ error: "Not found" }, 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 409);
    }
    const paused = req.reminders_paused === 0;
    store.toggleRemindersPaused(auth.workspace.id, req.id, paused, auth.actor, auth.actorLabel);
    return c.json({ ok: true, reminders_paused: paused });
  });

  app.post("/api/requests/:id/remind-now", async (c) => {
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
    const req = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!req) return c.json({ error: "Not found" }, 404);
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 409);
    }

    const items = store.listRequestItems(req.id);
    const requiredItems = items.filter((i) => i.required === 1);
    const checkSet = new Set((requiredItems.length > 0 ? requiredItems : items).map((i) => i.id));
    const outstanding = items.filter(
      (i) => (checkSet.has(i.id) || i.status === "rejected") && (i.status === "pending" || i.status === "rejected")
    );
    if (outstanding.length === 0) {
      return c.json({ error: "No outstanding items to remind the client about." }, 400);
    }

    const cooldownMs = deps.manualReminderCooldownMs ?? DEFAULT_MANUAL_REMINDER_COOLDOWN_MS;
    if (req.last_manual_reminder_at && cooldownMs > 0) {
      const elapsed = nowFn() - Date.parse(req.last_manual_reminder_at);
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

    if (inFlightReminders.has(req.id)) {
      return c.json({ error: "A reminder is already being sent for this request." }, 409);
    }
    inFlightReminders.add(req.id);

    try {
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

      try {
        await sendEmailTracked({
          workspaceId: auth.workspace.id,
          requestId: req.id,
          to: req.client_email,
          message,
          kind: "reminder",
          isDemo: req.is_demo === 1,
        });
      } catch (err) {
        const detail = config.multiTenant
          ? "Reminder email failed to send. Check your outbound email settings."
          : err instanceof Error
            ? err.message
            : "Reminder email failed to send.";
        return c.json({ error: detail }, 502);
      }

      const updated = store.recordManualReminderSent(
        auth.workspace.id,
        req.id,
        auth.actorLabel,
        outstanding.length,
        new Date(nowFn()).toISOString(),
        auth.actor
      );

      return c.json({
        ok: true,
        reminders_sent: updated.reminders_sent,
        last_manual_reminder_at: updated.last_manual_reminder_at,
        next_reminder_at: updated.next_reminder_at,
      });
    } finally {
      inFlightReminders.delete(req.id);
    }
  });

  app.patch("/api/requests/:id", async (c) => {
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
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

    store.updateRequestDueAt(auth.workspace.id, req.id, nextDue, auth.actorLabel, auth.actor);
    return c.json({ ok: true, due_at: nextDue });
  });

  app.post("/api/requests/:id/items", async (c) => {
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
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

    const added = store.addRequestItem(auth.workspace.id, req.id, spec, auth.actor, auth.actorLabel)!;
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
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
    const requestId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const body = (await c.req.json().catch(() => ({}))) as {
      decision?: unknown;
      note?: string;
    };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return c.json({ error: "Decision must be 'approved' or 'rejected'." }, 400);
    }
    const decision = body.decision;
    const note = String(body.note || "").trim();

    const item = store.getRequestItem(requestId, itemId);
    const reqBefore = store.getRequestById(auth.workspace.id, requestId);
    if (!reqBefore || !item) return c.json({ error: "Not found" }, 404);
    if (reqBefore.status === "purged" || reqBefore.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 409);
    }
    if (decision === "approved" && item.status === "pending") {
      return c.json({ error: "Cannot approve an item that has not been submitted." }, 409);
    }

    const { justCompleted, request } = store.reviewItem({
      workspaceId: auth.workspace.id,
      requestId,
      itemId,
      decision,
      note,
      actor: auth.actor,
      actorBy: auth.actorLabel,
    });

    let emailError: string | undefined;
    if (decision === "rejected") {
      const magicToken = decryptField(config.masterKey, request.token_encrypted, request.id);
      const portalUrl = `${config.baseUrl}/c/${magicToken}`;
      try {
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
      } catch (err) {
        emailError = config.multiTenant
          ? "Revision saved, but notification email failed to send."
          : err instanceof Error
            ? err.message
            : "Revision notification email failed to send.";
        store.logAudit(auth.workspace.id, request.id, "system", "revision.email_failed", {
          itemId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let webhookError: string | undefined;
    if (justCompleted) {
      webhookError = await emitWebhookSafe({
        workspace: auth.workspace,
        request,
        event: "request.completed",
      });
    }

    return c.json({
      ok: true,
      status: request.status,
      justCompleted,
      ...(emailError ? { emailError } : {}),
      ...(webhookError ? { webhookError } : {}),
    });
  });

  app.post("/api/requests/:id/approve-all-submitted", async (c) => {
    const resolved = resolveScopedAuth(c, "requests:write");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
    const requestId = c.req.param("id");
    const existing = store.getRequestById(auth.workspace.id, requestId);
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (existing.status === "purged" || existing.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 409);
    }

    const { approvedCount, justCompleted, request } = store.approveAllSubmitted(
      auth.workspace.id,
      requestId,
      auth.actor,
      auth.actorLabel
    );

    let webhookError: string | undefined;
    if (justCompleted) {
      webhookError = await emitWebhookSafe({
        workspace: auth.workspace,
        request,
        event: "request.completed",
      });
    }

    return c.json({
      ok: true,
      approvedCount,
      status: request.status,
      justCompleted,
      ...(webhookError ? { webhookError } : {}),
    });
  });

  async function streamDecryptedUpload(
    c: import("hono").Context<AppEnv>,
    uploadId: string,
    inline: boolean
  ) {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const upload = store.getUploadForWorkspace(auth.workspace.id, uploadId);
    if (!upload) return c.json({ error: "Not found" }, 404);

    let plaintext: Buffer;
    try {
      plaintext = await decryptStoredUpload(storage, config.masterKey, upload);
    } catch {
      return c.json({ error: "Could not decrypt file." }, 500);
    }

    store.logAudit(
      auth.workspace.id,
      upload.request_id,
      "operator",
      inline ? "upload.previewed" : "upload.downloaded",
      { uploadId: upload.id, canonicalName: upload.canonical_name }
    );

    const headers: Record<string, string> = {
      "content-type": upload.detected_mime,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${upload.canonical_name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    };
    if (inline) {
      headers["content-security-policy"] = "default-src 'none'; sandbox; frame-ancestors 'self'";
      headers["x-frame-options"] = "SAMEORIGIN";
    }
    return new Response(new Uint8Array(plaintext), { status: 200, headers });
  }

  app.get("/api/uploads/:uploadId/download", (c) =>
    streamDecryptedUpload(c, c.req.param("uploadId"), false)
  );
  app.get("/api/uploads/:uploadId/preview", (c) =>
    streamDecryptedUpload(c, c.req.param("uploadId"), true)
  );

  app.get("/api/requests/:id/export.zip", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const request = store.getRequestById(auth.workspace.id, c.req.param("id"));
    if (!request || request.status === "purged") return c.json({ error: "Not found" }, 404);

    const items = store.listRequestItems(request.id);
    const uploads = store.listUploadsForRequest(request.id);

    const entries: Array<{ upload: UploadRow; entryName: string }> = [];
    const usedNames = new Set<string>();
    try {
      for (const u of uploads) {
        // Pre-flight stream decryption verifies AES-GCM tag & storage availability without buffering files in RAM.
        const encStream = await storage.getStream(u.storage_key);
        const verifyStream = createDecryptStream(
          config.masterKey,
          encStream,
          {
            version: u.enc_version,
            ivHex: u.enc_iv,
            tagHex: u.enc_tag,
            saltHex: u.enc_salt,
          },
          u.storage_key
        );
        for await (const _chunk of verifyStream) {
          // drain to authenticate GCM tag
        }
        let entryName = `files/${u.canonical_name}`;
        if (usedNames.has(entryName)) {
          const ext = path.extname(u.canonical_name);
          const stem = u.canonical_name.slice(0, u.canonical_name.length - ext.length);
          entryName = `files/${stem}_${u.id.slice(-4)}${ext}`;
        }
        usedNames.add(entryName);
        entries.push({ upload: u, entryName });
      }
    } catch {
      return c.json({ error: "Could not decrypt one or more pack files." }, 500);
    }

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
        client_na: it.client_na === 1,
        client_note: it.client_note_encrypted
          ? decryptField(config.masterKey, it.client_note_encrypted, `${it.id}:note`)
          : null,
        files: uploads
          .filter((u) => u.request_item_id === it.id)
          .map((u) => ({ canonical_name: u.canonical_name, sha256: u.sha256, mime: u.detected_mime })),
      })),
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "summary.json");

    zip.on("error", (err) => {
      zip.outputStream.destroy(err);
    });
    for (const entry of entries) {
      const u = entry.upload;
      zip.addReadStreamLazy(entry.entryName, { compress: false }, (cb) => {
        storage
          .getStream(u.storage_key)
          .then((encStream) => {
            const decStream = createDecryptStream(
              config.masterKey,
              encStream,
              {
                version: u.enc_version,
                ivHex: u.enc_iv,
                tagHex: u.enc_tag,
                saltHex: u.enc_salt,
              },
              u.storage_key
            );
            decStream.on("error", (err) => {
              zip.outputStream.destroy(err);
            });
            cb(null, decStream);
          })
          .catch((err) => {
            cb(err instanceof Error ? err : new Error(String(err)));
          });
      });
    }
    zip.end();

    store.logAudit(auth.workspace.id, request.id, "operator", "request.exported_zip", {
      by: auth.user.email,
      fileCount: uploads.length,
      includesSensitiveValues: items.some(
        (it) => SENSITIVE_VALIDATORS.has(it.validator) && Boolean(it.value_encrypted)
      ),
    });

    const filename = `${slugify(request.client_name, "client")}-${slugify(request.title, "pack")}.zip`;
    const webStream = Readable.toWeb(zip.outputStream) as unknown as ReadableStream;
    return new Response(webStream, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Templates CRUD
  // ---------------------------------------------------------------------------
  app.get("/api/templates", (c) => {
    const resolved = resolveScopedAuth(c, "templates:read");
    if (resolved.error) return resolved.error;
    const { auth } = resolved;
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const result = store.deleteTemplate(auth.workspace.id, c.req.param("id"));
    if (!result.deleted) {
      return c.json({ error: result.reason || "Cannot delete template" }, result.reason?.includes("Built-in") ? 400 : 404);
    }
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Scoped Workspace API Keys (Interactive Session Only)
  // ---------------------------------------------------------------------------
  app.get("/api/api-keys", (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    return c.json({
      apiKeys: store.listApiKeys(auth.workspace.id).map(formatApiKey),
    });
  });

  app.post("/api/api-keys", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      scopes?: unknown;
      expiresInDays?: unknown;
    };
    const name = String(body.name || "").trim();
    if (!name || name.length > 80 || hasCrLf(name)) {
      return c.json({ error: "Enter a key name between 1 and 80 characters." }, 400);
    }

    let scopes: ApiKeyScope[];
    try {
      scopes = normalizeApiKeyScopes(body.scopes);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid API key scopes." }, 400);
    }

    const nowIso = new Date(nowFn()).toISOString();
    let expiresAt: string | null = null;
    const isBlankExpiry =
      body.expiresInDays === undefined ||
      body.expiresInDays === null ||
      (typeof body.expiresInDays === "string" && body.expiresInDays.trim() === "");
    if (!isBlankExpiry) {
      let days = NaN;
      if (typeof body.expiresInDays === "number") {
        days = body.expiresInDays;
      } else if (typeof body.expiresInDays === "string" && /^\d+$/.test(body.expiresInDays.trim())) {
        days = Number(body.expiresInDays.trim());
      }
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return c.json({ error: "Expiry must be a whole number of days between 1 and 3650." }, 400);
      }
      expiresAt = addDaysIso(nowIso, days);
    }

    const { rawKey, keyPrefix, keyHash } = generateApiKey();
    let created: ApiKeyRow;
    try {
      created = store.createApiKey({
        workspaceId: auth.workspace.id,
        name,
        keyPrefix,
        keyHash,
        scopes,
        createdByUserId: auth.user.id,
        actorEmail: auth.user.email,
        expiresAt,
        maxActiveKeys: MAX_ACTIVE_API_KEYS,
        nowIso,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Active API key limit")) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
    return c.json({ apiKey: formatApiKey(created), secret: rawKey }, 201);
  });

  app.delete("/api/api-keys/:id", (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const nowIso = new Date(nowFn()).toISOString();
    const revoked = store.revokeApiKey(auth.workspace.id, c.req.param("id"), nowIso);
    if (!revoked) return c.json({ error: "API key not found." }, 404);
    store.logAudit(auth.workspace.id, null, "operator", "api_key.revoked", {
      apiKeyId: revoked.id,
      name: revoked.name,
      keyPrefix: revoked.key_prefix,
      by: auth.user.email,
    });
    return c.json({ ok: true, apiKey: formatApiKey(revoked) });
  });

  // ---------------------------------------------------------------------------
  // Settings, Readiness, Local Email Outbox & Demo Controls
  // ---------------------------------------------------------------------------
  app.get("/api/settings", (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const emailSummary = summarizeWorkspaceEmail(auth.workspace);
    let webhookSecret = "";
    let webhookSecretError: string | undefined;
    try {
      webhookSecret = resolveWebhookSecret(auth.workspace, config.masterKey) || "";
    } catch (err) {
      webhookSecretError =
        err instanceof Error ? err.message : "Saved webhook secret could not be decrypted.";
    }
    return c.json({
      webhookUrl: auth.workspace.webhook_url || "",
      webhookSecret,
      ...(webhookSecretError ? { webhookSecretError } : {}),
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
        masterKeySource: config.masterKeySource,
        masterKeyAutoGenerated: config.masterKeySource === "file",
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    const resolved = resolveScopedAuth(c, "requests:read");
    if (resolved.error) return resolved.error;
    return c.json({ validators: listValidators() });
  });

  app.put("/api/settings/webhook", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const body = (await c.req.json().catch(() => ({}))) as {
      webhookUrl?: string;
      webhookSecret?: string;
    };
    const webhookUrl = String(body.webhookUrl || "").trim();
    const webhookSecret = String(body.webhookSecret || "").trim();

    if (webhookUrl) {
      const urlErr = validateWebhookEndpoint(webhookUrl, config.multiTenant);
      if (urlErr) return c.json({ error: urlErr }, 400);
    }

    const encryptedSecret = webhookSecret
      ? encryptField(config.masterKey, webhookSecret, `${auth.workspace.id}:webhook`)
      : null;
    store.updateWorkspaceWebhook(auth.workspace.id, webhookUrl || null, encryptedSecret);
    store.logAudit(auth.workspace.id, null, "operator", "settings.webhook_updated", {
      actorEmail: auth.user.email,
      configured: Boolean(webhookUrl),
      hasSecret: Boolean(webhookSecret),
    });
    return c.json({ ok: true });
  });

  app.post("/api/settings/webhook/test", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const limited = enforceRateLimit(
      c,
      [{ bucket: "settingsTest", key: auth.workspace.id }],
      "Too many webhook test requests. Please wait and try again."
    );
    if (limited) return limited;

    const savedUrl = auth.workspace.webhook_url?.trim();
    if (savedUrl) {
      const urlErr = validateWebhookEndpoint(savedUrl, config.multiTenant);
      if (urlErr) return c.json({ ok: false, error: urlErr }, 400);
    }
    const result = await dispatchTestWebhook({
      workspace: auth.workspace,
      masterKey: config.masterKey,
      multiTenant: config.multiTenant,
      fetchImpl: deps.fetchImpl,
      lookupImpl: deps.lookupImpl,
    });
    if (!result.ok) {
      return c.json(
        { ok: false, status: result.status, error: result.error || `HTTP ${result.status}` },
        400
      );
    }
    return c.json({ ok: true, status: result.status });
  });

  app.get("/api/settings/webhook/deliveries", (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const rawStatus = c.req.query("status")?.trim();
    const validStatuses = new Set<WebhookDeliveryStatus>([
      "pending",
      "in_flight",
      "retrying",
      "delivered",
      "dead_letter",
    ]);
    const status =
      rawStatus && rawStatus !== "all" && validStatuses.has(rawStatus as WebhookDeliveryStatus)
        ? (rawStatus as WebhookDeliveryStatus)
        : undefined;
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
    const rawOffset = Number(c.req.query("offset") ?? 0);
    const offset =
      Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.min(1_000_000, rawOffset) : 0;

    const deliveries = store
      .listWebhookDeliveries(auth.workspace.id, { status, limit, offset })
      .map(formatWebhookDelivery);
    const total = store.countWebhookDeliveries(auth.workspace.id, status);
    const deadLetterCount = store.countWebhookDeliveries(auth.workspace.id, "dead_letter");
    return c.json({
      deliveries,
      total,
      deadLetterCount,
      hasMore: offset + deliveries.length < total,
    });
  });

  app.post("/api/settings/webhook/deliveries/:id/replay", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const limited = enforceRateLimit(
      c,
      [{ bucket: "settingsTest", key: auth.workspace.id }],
      "Too many webhook replay requests. Please wait and try again."
    );
    if (limited) return limited;

    const delivery = store.getWebhookDeliveryForWorkspace(auth.workspace.id, c.req.param("id"));
    if (!delivery) return c.json({ error: "Webhook delivery not found." }, 404);

    const savedUrl = auth.workspace.webhook_url?.trim();
    if (!savedUrl) {
      return c.json({ ok: false, error: "Configure a webhook URL before replaying deliveries." }, 400);
    }
    const urlErr = validateWebhookEndpoint(savedUrl, config.multiTenant);
    if (urlErr) return c.json({ ok: false, error: urlErr }, 400);

    const result = await replayWebhookDelivery({
      store,
      workspace: auth.workspace,
      delivery,
      masterKey: config.masterKey,
      actorEmail: auth.user.email,
      multiTenant: config.multiTenant,
      fetchImpl: deps.fetchImpl,
      lookupImpl: deps.lookupImpl,
      nowMs: nowFn(),
    });
    const formatted = formatWebhookDelivery(result.delivery);
    if (!result.ok) {
      return c.json(
        { ok: false, status: result.status, error: result.error || `HTTP ${result.status}`, delivery: formatted },
        400
      );
    }
    return c.json({ ok: true, status: result.status, delivery: formatted });
  });

  app.put("/api/settings/email", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    const existingWorkspace = existing.source === "workspace" ? existing : null;
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
      if (config.multiTenant && (isPrivateOrLocalHost(host) || !MULTI_TENANT_SMTP_PORTS.has(port))) {
        return c.json(
          { error: "SMTP host must be a public hostname on a standard port (25, 465, 587, 2525) in multi-tenant mode." },
          400
        );
      }
      if (hasCrLf(user)) {
        return c.json({ error: "SMTP username cannot contain line breaks." }, 400);
      }
      const clearPass = body.smtp?.clearPass === true;
      const rawPass = typeof body.smtp?.pass === "string" ? body.smtp.pass : "";
      const sameSmtpIdentity = Boolean(
        existingWorkspace?.smtp &&
          existingWorkspace.smtp.host === host &&
          existingWorkspace.smtp.port === port &&
          existingWorkspace.smtp.user === user
      );
      const pass = clearPass
        ? ""
        : rawPass.length > 0
          ? rawPass
          : sameSmtpIdentity
            ? existingWorkspace?.smtp?.pass || ""
            : "";
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
      const apiKey = rawKey || existingWorkspace?.resendApiKey || "";
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const limited = enforceRateLimit(
      c,
      [{ bucket: "settingsTest", key: auth.workspace.id }],
      "Too many test email requests. Please wait and try again."
    );
    if (limited) return limited;

    const body = (await c.req.json().catch(() => ({}))) as { to?: string };
    const to = String(body.to || auth.user.email).trim();
    if (!to || hasCrLf(to) || !validateTextValue("email", to).valid) {
      return c.json({ error: "Enter a valid recipient email." }, 400);
    }
    const resolved = resolveWorkspaceEmail(auth.workspace, config, config.masterKey);
    if (resolved.backend === "smtp" && !resolved.smtp?.host) {
      return c.json({ error: "Configure an SMTP host before sending a test email." }, 400);
    }
    if (resolved.backend === "smtp" && resolved.source === "workspace" && config.multiTenant) {
      const dnsErr = await assertPublicHostname(resolved.smtp!.host, deps.lookupImpl);
      if (dnsErr) {
        return c.json(
          { ok: false, error: "SMTP host must resolve to a public address in multi-tenant mode." },
          400
        );
      }
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
      const detail =
        config.multiTenant && resolved.backend === "smtp"
          ? "Email delivery failed. Check your SMTP host, port, credentials, and TLS settings."
          : err instanceof Error
            ? err.message
            : "Email send failed";
      return c.json({ ok: false, error: detail }, 400);
    }
  });

  app.put("/api/account", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    store.logAudit(auth.workspace.id, null, "operator", "account.profile_updated", {
      actorEmail: auth.user.email,
      nextEmail,
    });
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const ip = extractClientIp(c, config.trustProxy);
    const limited = enforceRateLimit(
      c,
      [
        { bucket: "loginAccount", key: `pw:${auth.user.id}` },
        { bucket: "loginIp", key: `pw:${ip}` },
      ],
      "Too many password change attempts. Please wait and try again."
    );
    if (limited) return limited;
    const body = (await c.req.json().catch(() => ({}))) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (currentPassword.length > MAX_PASSWORD_CHARS || !verifyPassword(currentPassword, auth.user.password_hash)) {
      return c.json({ error: "Current password is incorrect." }, 400);
    }
    if (newPassword.length < 10 || newPassword.length > MAX_PASSWORD_CHARS) {
      return c.json({ error: "New password must be between 10 and 256 characters." }, 400);
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
    const resolvedEmail = resolveWorkspaceEmail(auth.workspace, config, config.masterKey);
    return c.json({
      emailBackend: resolvedEmail.backend,
      emails: store.listOutboxEmails(auth.workspace.id, 100),
    });
  });

  app.post("/api/demo/seed", async (c) => {
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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
    const auth = requireSessionOnly(c);
    if (auth.error) return auth.error;
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

  app.get("/api/client/:token", async (c) => {
    const token = c.req.param("token");
    const request = store.getRequestByMagicToken(token);
    if (!request) return c.json({ error: "Invalid or expired checklist link." }, 404);
    const workspace = store.getWorkspaceById(request.workspace_id);
    if (!workspace) return c.json({ error: "Not found" }, 404);

    if (request.status === "expired") {
      return c.json({ error: "This checklist link has expired." }, 410);
    }

    if (request.status === "purged") {
      return c.json({
        requiresOtp: false,
        workspaceName: workspace.name,
        branding: publicBranding(workspace),
        request: {
          id: request.id,
          title: request.title,
          status: request.status,
          purge_at: request.purge_at,
        },
        items: [],
      });
    }

    if (!isClientVerified(c, request)) {
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

    const openNowMs = nowFn();
    const openNowIso = new Date(openNowMs).toISOString();
    const targetUrl = workspace.webhook_url?.trim() || "";
    let openDelivery: WebhookDeliveryRow | undefined;
    try {
      openDelivery = store.touchRequestOpenedAndQueueWebhook(
        request.id,
        openNowIso,
        targetUrl
          ? (openedAt) => ({
              workspaceId: workspace.id,
              targetUrl,
              payloadJson: buildWebhookEventPayload({
                store,
                workspace,
                request,
                event: "request.opened",
                masterKey: config.masterKey,
                baseUrl: config.baseUrl,
                nowIso: openNowIso,
                openedAt,
              }),
              maxAttempts: MAX_WEBHOOK_ATTEMPTS,
            })
          : undefined
      ).delivery;
    } catch (err) {
      console.error(`[GatherGate] failed to queue request.opened for ${request.id}:`, err);
    }
    if (openDelivery) {
      try {
        await attemptWebhookDelivery({
          store,
          delivery: openDelivery,
          masterKey: config.masterKey,
          multiTenant: config.multiTenant,
          fetchImpl: deps.fetchImpl,
          lookupImpl: deps.lookupImpl,
          nowMs: openNowMs,
          workspaceOverride: workspace,
        });
      } catch {
        // Row stays durable in webhook_deliveries for background retry.
      }
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
    const ip = extractClientIp(c, config.trustProxy);
    const tokenHash = sha256Hex(token);
    const limited = enforceRateLimit(
      c,
      [
        { bucket: "otpSendIp", key: ip },
        { bucket: "otpSendToken", key: tokenHash },
      ],
      "Too many verification code requests. Please wait before trying again."
    );
    if (limited) return limited;

    const request = store.getRequestByMagicToken(token);
    if (!request || request.status === "purged" || request.status === "expired") {
      return c.json({ error: "Not found" }, 404);
    }
    if (request.require_otp !== 1) {
      return c.json({ error: "Verification code is not required for this checklist." }, 400);
    }
    const workspace = store.getWorkspaceById(request.workspace_id);
    if (!workspace) return c.json({ error: "Not found" }, 404);
    const { code, hash } = generateOtpCode();
    store.createOtpCode(request.id, hash, 15, nowFn());

    try {
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
    } catch (err) {
      store.logAudit(request.workspace_id, request.id, "system", "otp.send_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Could not send verification code. Please try again shortly." }, 502);
    }
    store.logAudit(request.workspace_id, request.id, "client", "otp.sent", {});
    return c.json({ ok: true, maskedEmail: maskEmail(request.client_email) });
  });

  app.post("/api/client/:token/otp/verify", async (c) => {
    const token = c.req.param("token");
    const ip = extractClientIp(c, config.trustProxy);
    const tokenHash = sha256Hex(token);
    const limited = enforceRateLimit(
      c,
      [
        { bucket: "otpVerifyIp", key: ip },
        { bucket: "otpVerifyToken", key: tokenHash },
      ],
      "Too many verification attempts. Please wait before trying again."
    );
    if (limited) return limited;

    const request = store.getRequestByMagicToken(token);
    if (!request || request.status === "purged" || request.status === "expired") {
      return c.json({ error: "Not found" }, 404);
    }
    if (request.require_otp !== 1) {
      return c.json({ error: "Verification code is not required for this checklist." }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const submitted = String(body.code || "");
    const active = store.getActiveOtpCode(request.id);

    if (!active || active.expires_at <= new Date(nowFn()).toISOString()) {
      return c.json({ error: "Verification code expired. Request a new code." }, 400);
    }
    if (active.attempts >= 5) {
      return c.json({ error: "Too many attempts. Request a new code." }, 429);
    }
    if (!verifyOtpCode(submitted, active.code_hash)) {
      store.incrementOtpAttempts(active.id);
      if (active.attempts + 1 >= 5) {
        return c.json({ error: "Too many attempts. Request a new code." }, 429);
      }
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
    if (
      !request ||
      request.status === "purged" ||
      request.status === "completed" ||
      request.status === "expired"
    ) {
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
    const prevRequestStatus = request.status;

    if (item.kind === "checkbox") {
      const body = (await c.req.json().catch(() => ({}))) as { checked?: boolean | string };
      const isChecked = body.checked === true || body.checked === "1" || body.checked === "true";
      if (!isChecked) {
        return c.json({ error: "Please confirm the declaration checkbox." }, 400);
      }
      try {
        store.saveTextOrCheckboxSubmission(
          item.id,
          request.id,
          encryptField(config.masterKey, "confirmed", item.id)
        );
      } catch (err) {
        if (err instanceof ClientWriteConflictError) {
          return c.json({ error: err.message }, err.statusCode);
        }
        throw err;
      }
      store.logAudit(request.workspace_id, request.id, "client", "item.submitted", {
        itemId: item.id,
        kind: "checkbox",
      });
      const updated = store.getRequestItem(request.id, item.id)!;
      const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
      await emitWebhookSafe({ workspace, request: reqAfter, event: "item.submitted", item: updated });
      if (prevRequestStatus !== "in_review" && reqAfter.status === "in_review") {
        await emitWebhookSafe({ workspace, request: reqAfter, event: "request.in_review" });
      }
      return c.json({
        ok: true,
        requestStatus: reqAfter.status,
        item: { status: updated.status, currentValue: "confirmed", isSensitiveMasked: false },
      });
    }

    if (item.kind === "text" || item.kind === "textarea") {
      const body = (await c.req.json().catch(() => ({}))) as { value?: string };
      const rawValue = String(body.value || "");
      const maxChars = item.kind === "textarea" ? MAX_TEXTAREA_ITEM_CHARS : MAX_TEXT_ITEM_CHARS;
      if (rawValue.length > maxChars) {
        return c.json({ error: `Value exceeds maximum length of ${maxChars} characters.` }, 400);
      }
      const check = validateTextValue(item.validator, rawValue);
      if (!check.valid || !check.normalised) {
        return c.json({ error: check.error || "Invalid value" }, 400);
      }
      try {
        store.saveTextOrCheckboxSubmission(
          item.id,
          request.id,
          encryptField(config.masterKey, check.normalised, item.id)
        );
      } catch (err) {
        if (err instanceof ClientWriteConflictError) {
          return c.json({ error: err.message }, err.statusCode);
        }
        throw err;
      }
      store.logAudit(request.workspace_id, request.id, "client", "item.submitted", {
        itemId: item.id,
        kind: item.kind,
        validator: item.validator,
      });
      const updated = store.getRequestItem(request.id, item.id)!;
      const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
      await emitWebhookSafe({ workspace, request: reqAfter, event: "item.submitted", item: updated });
      if (prevRequestStatus !== "in_review" && reqAfter.status === "in_review") {
        await emitWebhookSafe({ workspace, request: reqAfter, event: "request.in_review" });
      }
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
    const ip = extractClientIp(c, config.trustProxy);
    const limited = enforceRateLimit(
      c,
      [
        { bucket: "uploadIp", key: ip },
        { bucket: "uploadToken", key: sha256Hex(token) },
      ],
      "Too many file uploads. Please wait before trying again."
    );
    if (limited) return limited;

    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      return c.json({ error: "Invalid multipart upload payload." }, 400);
    }
    const rawFiles = formData.getAll("file").filter((v): v is File => v instanceof File && v.size > 0);
    if (rawFiles.length === 0) {
      return c.json({ error: "Please choose at least one file to upload." }, 400);
    }

    const cfg = JSON.parse(item.config_json) as {
      allowedGroups?: string[];
      maxFileMb?: number;
      multiple?: boolean;
      slug?: string;
    };
    if (!cfg.multiple && rawFiles.length > 1) {
      return c.json({ error: "This item only accepts one file at a time." }, 400);
    }
    if (rawFiles.length > MAX_FILES_PER_UPLOAD) {
      return c.json({ error: `Upload up to ${MAX_FILES_PER_UPLOAD} files at a time.` }, 400);
    }

    const maxFileMb = Math.min(MAX_ITEM_FILE_MB, Math.max(1, cfg.maxFileMb ?? 20));
    const maxBytes = maxFileMb * 1024 * 1024;
    const allowedMimes = resolveAllowedMimes(cfg.allowedGroups);
    const currentStorage = store.getWorkspaceStorageBytes(workspace.id);

    // Pass 1: validate every file's size, workspace quota, and magic bytes before persisting anything.
    let pendingBytes = 0;
    const preparedFiles: Array<{
      name: string;
      buf: Buffer;
      detected: { mime: string; ext: string };
    }> = [];
    for (const file of rawFiles) {
      if (file.size > maxBytes) {
        return c.json(
          { error: `"${file.name}" exceeds max size of ${maxFileMb} MB.` },
          400
        );
      }
      if (
        workspace.max_storage_bytes > 0 &&
        currentStorage + pendingBytes + file.size > workspace.max_storage_bytes
      ) {
        return c.json({ error: "Workspace storage limit reached." }, 403);
      }

      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        return c.json(
          { error: `"${file.name}" exceeds max size of ${maxFileMb} MB.` },
          400
        );
      }
      if (
        workspace.max_storage_bytes > 0 &&
        currentStorage + pendingBytes + buf.byteLength > workspace.max_storage_bytes
      ) {
        return c.json({ error: "Workspace storage limit reached." }, 403);
      }
      const detected = detectFileSignature(buf, file.name);
      if (!detected || !allowedMimes.includes(detected.mime)) {
        return c.json(
          {
            error: `"${file.name}" failed file-type verification. Upload an allowed PDF, image, spreadsheet, or document.`,
          },
          400
        );
      }
      pendingBytes += buf.byteLength;
      preparedFiles.push({ name: file.name, buf, detected });
    }

    // Pass 2: encrypt and write all blobs first, then commit all DB rows in one atomic transaction.
    const writtenStorageKeys: string[] = [];
    const stagedUploads: Array<Parameters<Store["addUpload"]>[0]> = [];
    const clientSlug = slugify(request.client_name, "client");
    const itemSlug = slugify(cfg.slug || item.label, "doc");
    let seq = store.nextUploadSeqForItem(item.id);
    let savedUploads: Array<{
      id: string;
      original_name: string;
      canonical_name: string;
      detected_mime: string;
      size_bytes: number;
      created_at: string;
    }>;

    try {
      for (const pf of preparedFiles) {
        const uploadId = generateId("upl");
        const canonicalName = `${clientSlug}_${itemSlug}_${String(seq).padStart(2, "0")}.${pf.detected.ext}`;
        seq += 1;
        const storageKey = `${workspace.id}/${request.id}/${item.id}/${uploadId}_${canonicalName}.enc`;

        const { ciphertext, meta } = encryptBuffer(config.masterKey, pf.buf, storageKey);
        await storage.put(storageKey, ciphertext);
        writtenStorageKeys.push(storageKey);

        stagedUploads.push({
          id: uploadId,
          itemId: item.id,
          requestId: request.id,
          originalName: pf.name.slice(0, 200),
          canonicalName,
          detectedMime: pf.detected.mime,
          sizeBytes: meta.sizeBytes,
          storageKey,
          encVersion: meta.version,
          ivHex: meta.ivHex,
          tagHex: meta.tagHex,
          saltHex: meta.saltHex,
          sha256Hex: meta.sha256Hex,
        });
      }

      const uploadRows = store.addUploads(stagedUploads);
      savedUploads = uploadRows.map((uploadRow) => ({
        id: uploadRow.id,
        original_name: uploadRow.original_name,
        canonical_name: uploadRow.canonical_name,
        detected_mime: uploadRow.detected_mime,
        size_bytes: uploadRow.size_bytes,
        created_at: uploadRow.created_at,
      }));
    } catch (err) {
      for (const k of writtenStorageKeys) {
        await storage.delete(k).catch(() => {});
      }
      if (err instanceof ClientWriteConflictError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      throw err;
    }

    if (!cfg.multiple && savedUploads.length > 0) {
      const oldKeys = store.deleteOtherUploadsForItem(request.id, item.id, savedUploads[0].id);
      for (const oldKey of oldKeys) {
        await storage.delete(oldKey).catch(() => {});
      }
    }

    store.logAudit(request.workspace_id, request.id, "client", "item.files_uploaded", {
      itemId: item.id,
      count: savedUploads.length,
    });
    const updatedFileItem = store.getRequestItem(request.id, item.id)!;
    const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
    await emitWebhookSafe({ workspace, request: reqAfter, event: "item.submitted", item: updatedFileItem });
    if (prevRequestStatus !== "in_review" && reqAfter.status === "in_review") {
      await emitWebhookSafe({ workspace, request: reqAfter, event: "request.in_review" });
    }
    return c.json({
      ok: true,
      requestStatus: reqAfter.status,
      uploads: savedUploads,
    });
  });

  /** Shared guard for client writes: open request, verified client, item not locked. */
  function resolveClientWrite(c: import("hono").Context<AppEnv>, itemId: string) {
    const request = store.getRequestByMagicToken(c.req.param("token") ?? "");
    if (
      !request ||
      request.status === "purged" ||
      request.status === "completed" ||
      request.status === "expired"
    ) {
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
    const prevRequestStatus = request.status;
    try {
      store.setClientNote(
        item.id,
        request.id,
        note ? encryptField(config.masterKey, note, `${item.id}:note`) : null,
        notApplicable
      );
    } catch (err) {
      if (err instanceof ClientWriteConflictError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      throw err;
    }
    store.logAudit(request.workspace_id, request.id, "client", notApplicable ? "item.marked_na" : "item.note_saved", {
      itemId: item.id,
    });
    const updated = store.getRequestItem(request.id, item.id)!;
    const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
    if (notApplicable) {
      const ws = store.getWorkspaceById(request.workspace_id);
      if (ws) {
        await emitWebhookSafe({ workspace: ws, request: reqAfter, event: "item.submitted", item: updated });
        if (prevRequestStatus !== "in_review" && reqAfter.status === "in_review") {
          await emitWebhookSafe({ workspace: ws, request: reqAfter, event: "request.in_review" });
        }
      }
    }
    return c.json({
      ok: true,
      requestStatus: reqAfter.status,
      item: { status: updated.status, client_note: note || null, client_na: updated.client_na === 1 },
    });
  });

  app.delete("/api/client/:token/uploads/:uploadId", async (c) => {
    const request = store.getRequestByMagicToken(c.req.param("token"));
    if (!request) return c.json({ error: "File not found" }, 404);
    if (request.status === "purged" || request.status === "completed" || request.status === "expired") {
      return c.json({ error: "Checklist is closed." }, 403);
    }
    if (!isClientVerified(c, request)) {
      return c.json({ error: "Email verification required." }, 401);
    }
    const upload = store.getUploadForRequest(request.id, c.req.param("uploadId"));
    if (!upload) return c.json({ error: "File not found" }, 404);
    const resolved = resolveClientWrite(c, upload.request_item_id);
    if (resolved.error) return resolved.error;

    let removed: { storageKey: string; itemId: string } | null;
    try {
      removed = store.deleteUpload(request.id, upload.id);
    } catch (err) {
      if (err instanceof ClientWriteConflictError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      throw err;
    }
    if (removed) await storage.delete(removed.storageKey);
    store.logAudit(request.workspace_id, request.id, "client", "item.file_removed", {
      itemId: upload.request_item_id,
      originalName: upload.original_name,
    });
    const updated = store.getRequestItem(request.id, upload.request_item_id)!;
    const reqAfter = store.getRequestById(request.workspace_id, request.id)!;
    return c.json({ ok: true, requestStatus: reqAfter.status, item: { status: updated.status } });
  });

  // ---------------------------------------------------------------------------
  // Built-In Stateless MCP 2.0 Endpoint (POST /mcp, Bearer API Key Only)
  // ---------------------------------------------------------------------------
  app.options("/mcp", (c) => {
    c.header("Allow", "POST, OPTIONS");
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id"
    );
    c.header("Access-Control-Max-Age", "600");
    return c.body(null, 204);
  });

  app.post("/mcp", async (c) => {
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/json") {
      return c.json(
        { error: "Unsupported Media Type: POST /mcp requires Content-Type: application/json." },
        415
      );
    }

    const acceptHeader = c.req.header("accept")?.trim();
    if (acceptHeader && !acceptsApplicationJson(acceptHeader)) {
      return c.json({ error: "Not Acceptable: POST /mcp responds with application/json." }, 406);
    }

    const authHeader = c.req.header("authorization")?.trim();
    if (!authHeader) {
      c.header("WWW-Authenticate", 'Bearer realm="GatherGate MCP"');
      return c.json({ error: "Bearer API key required for MCP." }, 401);
    }

    const resolved = resolveScopedAuth(c, "mcp:read");
    if (resolved.error) {
      if (resolved.error.status === 401) {
        resolved.error.headers.set(
          "WWW-Authenticate",
          'Bearer realm="GatherGate MCP", error="invalid_token"'
        );
      }
      return resolved.error;
    }
    if (resolved.auth.kind !== "api_key") {
      c.header("WWW-Authenticate", 'Bearer realm="GatherGate MCP"');
      return c.json({ error: "Bearer API key required for MCP." }, 401);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: invalid JSON body." },
        },
        400
      );
    }

    let res: Awaited<ReturnType<typeof handleMcpJsonRpc>>;
    try {
      res = await handleMcpJsonRpc(
        rawBody,
        {
          workspace: resolved.auth.workspace,
          apiKey: resolved.auth.apiKey,
          scopes: resolved.auth.scopes,
        },
        {
          config,
          store,
          sendEmail: sendEmailTracked,
          nowFn,
          manualReminderCooldownMs: deps.manualReminderCooldownMs,
          inFlightReminders,
        },
        {
          protocolVersionHeader: c.req.header("mcp-protocol-version") ?? null,
          mcpMethodHeader: c.req.header("mcp-method") ?? null,
          mcpNameHeader: c.req.header("mcp-name") ?? null,
        }
      );
    } catch (err) {
      console.error("[GatherGate MCP] unhandled error:", err);
      const rawId =
        rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
          ? (rawBody as { id?: unknown }).id
          : null;
      const safeId =
        typeof rawId === "string" || typeof rawId === "number" || rawId === null ? rawId : null;
      return c.json(
        {
          jsonrpc: "2.0",
          id: safeId,
          error: { code: -32603, message: "Internal error" },
        },
        500
      );
    }

    if (res.headers) {
      for (const [k, v] of Object.entries(res.headers)) {
        c.header(k, v);
      }
    }
    if (res.status === 202 || !res.body) {
      return c.body(null, 202);
    }
    return c.json(res.body, res.status as 200 | 400 | 404);
  });

  app.all("/mcp", (c) => {
    c.header("Allow", "POST, OPTIONS");
    return c.json({ error: "Method Not Allowed. GatherGate MCP is stateless; send JSON-RPC via POST /mcp." }, 405);
  });

  app.all("/.well-known/*", (c) => c.json({ error: "Not found" }, 404));
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

  app.all("/assets/*", (c) => c.text("Not found", 404));

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

  return { app, store, inFlightReminders };
}
