import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import type { ApiKeyRow, RequestRow, Store, WorkspaceRow } from "../db/queries.js";
import { emailBrand, inviteEmail, reminderEmail, type RenderedEmail } from "../emails/templates.js";
import type { ApiKeyScope } from "../security/auth.js";
import { decryptField } from "../security/crypto.js";
import type { TemplateItemSpec } from "../templates/presets.js";
import {
  isKnownValidator,
  SENSITIVE_VALIDATORS,
  validateTextValue,
} from "../validators/index.js";
import { SENSITIVE_DEFAULT_PURGE_DAYS } from "../config.js";
import {
  getBundledGatherGateSkill,
  getBundledSkillResource,
  type BundledSkill,
} from "./skills.js";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
export const MCP_PROTOCOL_VERSIONS = [
  MCP_MODERN_PROTOCOL_VERSION,
  ...MCP_LEGACY_PROTOCOL_VERSIONS,
] as const;

export const MCP_DEFAULT_PROTOCOL_VERSION = MCP_MODERN_PROTOCOL_VERSION;
export const MCP_LEGACY_DEFAULT_VERSION = "2025-11-25";
export const MCP_HEADERLESS_FALLBACK_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = new Set<string>(MCP_PROTOCOL_VERSIONS);
const SUPPORTED_LEGACY_VERSIONS = new Set<string>(MCP_LEGACY_PROTOCOL_VERSIONS);
const MCP_CACHE_TTL_MS = 300_000;
const FALLBACK_IN_FLIGHT_REMINDERS = new Set<string>();
const MCP_SERVER_INSTRUCTIONS =
  "GatherGate MCP is strictly metadata-only: never ask for or expect decrypted national IDs, client notes, file names, or uploaded bytes. Direct operators to review_url to inspect documents inside GatherGate's browser ReviewSheet. Read skill://gathergate/SKILL.md for workflows.";

function loadServerVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

export const MCP_SERVER_VERSION = loadServerVersion();

const DEFAULT_MANUAL_REMINDER_COOLDOWN_MS = 15 * 60_000;
const VALID_REQUEST_STATUSES = new Set(["open", "in_review", "completed", "expired", "purged"]);

export interface McpAuthContext {
  workspace: WorkspaceRow;
  apiKey: ApiKeyRow;
  scopes: Set<ApiKeyScope>;
}

export interface McpHandlerDeps {
  config: AppConfig;
  store: Store;
  sendEmail: (params: {
    workspace?: WorkspaceRow;
    workspaceId: string;
    requestId: string | null;
    to: string;
    message: RenderedEmail;
    kind: string;
    isDemo?: boolean;
  }) => Promise<void>;
  nowFn: () => number;
  manualReminderCooldownMs?: number;
  inFlightReminders?: Set<string>;
}

export interface McpRequestOptions {
  protocolVersionHeader?: string | null;
  mcpMethodHeader?: string | null;
  mcpNameHeader?: string | null;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpHttpResult {
  status: number;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface McpToolDefinition {
  name: string;
  description: string;
  requiredScope: ApiKeyScope;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: ReadonlyArray<McpToolDefinition> = [
  {
    name: "list_templates",
    description:
      "List checklist templates available in this workspace (metadata and item structure only).",
    requiredScope: "mcp:read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "list_requests",
    description:
      "List client intake requests with progress counts and operator review_url deep links. Strictly metadata-only: never returns sensitive values, client notes, file names, file bytes, or magic-link tokens.",
    requiredScope: "mcp:read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["open", "in_review", "completed", "expired", "purged"],
          description: "Optional status filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of requests to return (default 20, max 50).",
        },
      },
    },
  },
  {
    name: "get_request_status",
    description:
      "Get metadata-only checklist progress and per-item completion states for one request, plus its operator review_url. Never exposes decrypted text values, national IDs, client notes, or uploaded files.",
    requiredScope: "mcp:read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id"],
      properties: {
        request_id: {
          type: "string",
          minLength: 1,
          description: "GatherGate request ID (e.g. req_...).",
        },
      },
    },
  },
  {
    name: "list_overdue_requests",
    description:
      "List active open or in-review requests whose due_at has passed (or is due within within_days), including outstanding item labels and operator review_url links.",
    requiredScope: "mcp:read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        within_days: {
          type: "integer",
          minimum: 0,
          maximum: 30,
          description: "Include active packs due within the next N days (default 0 = overdue only).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of overdue requests to return (default 50, max 50).",
        },
      },
    },
  },
  {
    name: "create_request",
    description:
      "Create a new client document checklist request from an existing workspace template and optionally email the magic-link invite directly to the client. Requires requests:write scope. Returns request_id and operator review_url (never the raw client magic token).",
    requiredScope: "requests:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["template_id", "title", "client_name", "client_email"],
      properties: {
        template_id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        client_name: { type: "string", minLength: 1, maxLength: 120 },
        client_email: { type: "string", minLength: 3, maxLength: 200 },
        due_at: {
          type: "string",
          description: "Optional ISO 8601 deadline timestamp.",
        },
        require_otp: {
          type: "boolean",
          description: "Require 6-digit email OTP before the client opens the pack (recommended for sensitive packs).",
        },
        send_invite: {
          type: "boolean",
          description: "Email the client portal invite immediately (default true).",
        },
        welcome_note: {
          type: "string",
          maxLength: 2000,
          description: "Optional personalised note shown at the top of the client checklist.",
        },
      },
    },
  },
  {
    name: "send_reminder",
    description:
      "Send a polite manual reminder email for an active request with outstanding items (enforces the 15-minute cooldown). Requires requests:write scope.",
    requiredScope: "requests:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id"],
      properties: {
        request_id: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "update_due_date",
    description:
      "Update or clear the due_at deadline on an active request. Requires requests:write scope.",
    requiredScope: "requests:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id", "due_at"],
      properties: {
        request_id: { type: "string", minLength: 1 },
        due_at: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "ISO 8601 timestamp, or null to clear the due date.",
        },
      },
    },
  },
];

function hasCrLf(value: string): boolean {
  return /[\r\n]/.test(value);
}

function isValidEmailAddress(email: string): boolean {
  return Boolean(
    email && !hasCrLf(email) && !/[,\s;<>]/.test(email) && validateTextValue("email", email).valid
  );
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  if (local.length <= 2) return `***@${domain}`;
  const visible = local.length === 3 ? 1 : 2;
  return `${local.slice(0, visible)}***@${domain}`;
}

function serializeSkillEntry(skill: BundledSkill) {
  return {
    uri: skill.uri,
    frontmatter: {
      name: skill.name,
      description: skill.description,
    },
    resources: skill.files.map((f) => ({
      uri: f.uri,
      digest: `sha256:${f.sha256}`,
      size: f.size,
    })),
  };
}

function safeLogAudit(
  store: Store,
  workspaceId: string,
  requestId: string | null,
  actor: "operator" | "client" | "system" | "api_key",
  action: string,
  detail: Record<string, unknown>
): void {
  try {
    store.logAudit(workspaceId, requestId, actor, action, detail);
  } catch {
    // Audit logging is best-effort once state or mail delivery has already committed.
  }
}

function rpcOk(
  id: string | number | null,
  result: Record<string, unknown>,
  protocolVersion: string = MCP_DEFAULT_PROTOCOL_VERSION
): McpHttpResult {
  const payload =
    protocolVersion === "2026-07-28"
      ? { resultType: "complete", ...result }
      : result;
  return {
    status: 200,
    headers: { "mcp-protocol-version": protocolVersion },
    body: { jsonrpc: "2.0", id, result: payload },
  };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
  httpStatus = 200,
  protocolVersion: string = MCP_DEFAULT_PROTOCOL_VERSION
): McpHttpResult {
  return {
    status: httpStatus,
    headers: { "mcp-protocol-version": protocolVersion },
    body: {
      jsonrpc: "2.0",
      id,
      error: data ? { code, message, data } : { code, message },
    },
  };
}

function toolOk(data: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: false,
  };
}

function toolErr(message: string) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function serializeRequestSummary(
  row: RequestRow & {
    total_items: number;
    approved_items: number;
    submitted_items: number;
    rejected_items: number;
  },
  baseUrl: string
) {
  const total = Number(row.total_items || 0);
  const approved = Number(row.approved_items || 0);
  const submitted = Number(row.submitted_items || 0);
  const rejected = Number(row.rejected_items || 0);
  const pending = Math.max(0, total - approved - submitted - rejected);
  const isPurged = row.status === "purged";
  return {
    request_id: row.id,
    title: row.title,
    client_name: isPurged ? null : row.client_name,
    client_email_masked: isPurged ? null : maskEmail(row.client_email),
    status: row.status,
    require_otp: row.require_otp === 1,
    due_at: row.due_at,
    created_at: row.created_at,
    last_opened_at: row.last_opened_at,
    reminders_sent: row.reminders_sent,
    max_reminders: row.max_reminders,
    reminders_paused: row.reminders_paused === 1,
    next_reminder_at: row.next_reminder_at,
    completed_at: row.completed_at,
    purge_at: row.purge_at,
    counts: { total, pending, submitted, approved, rejected },
    review_url: `${baseUrl}/requests/${row.id}`,
  };
}

export async function handleMcpJsonRpc(
  rawBody: unknown,
  auth: McpAuthContext,
  deps: McpHandlerDeps,
  options?: McpRequestOptions
): Promise<McpHttpResult> {
  const headerVersion = options?.protocolVersionHeader?.trim() ?? "";
  const errorVersion = SUPPORTED_PROTOCOL_VERSIONS.has(headerVersion)
    ? headerVersion
    : MCP_DEFAULT_PROTOCOL_VERSION;

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return rpcError(
      null,
      -32600,
      "Invalid Request: expected a single JSON-RPC 2.0 object.",
      undefined,
      400,
      errorVersion
    );
  }

  const msg = rawBody as Partial<JsonRpcRequest>;
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const rawId = msg.id;
  if (hasId && rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
    return rpcError(
      null,
      -32600,
      "Invalid Request: id must be string, number, or null.",
      undefined,
      400,
      errorVersion
    );
  }
  const id: string | number | null = hasId ? (rawId as string | number | null) : null;

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !msg.method) {
    return rpcError(
      id,
      -32600,
      "Invalid Request: expected jsonrpc '2.0' and string method.",
      undefined,
      400,
      errorVersion
    );
  }

  const params =
    msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};

  // Validate per-request protocol version (MCP-Protocol-Version header and _meta).
  let activeVersion: string =
    msg.method === "server/discover" && !headerVersion
      ? MCP_MODERN_PROTOCOL_VERSION
      : MCP_HEADERLESS_FALLBACK_VERSION;

  if (msg.method === "initialize") {
    if (headerVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(headerVersion)) {
      return rpcError(
        id,
        -32022,
        "Unsupported protocol version.",
        { supported: [...MCP_PROTOCOL_VERSIONS], requested: headerVersion },
        400,
        errorVersion
      );
    }
    if (headerVersion === MCP_MODERN_PROTOCOL_VERSION) {
      return rpcError(
        id,
        -32601,
        "Method not found: initialize is removed in 2026-07-28; use server/discover.",
        undefined,
        404,
        MCP_MODERN_PROTOCOL_VERSION
      );
    }
  } else {
    const metaObj =
      params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
        ? (params._meta as Record<string, unknown>)
        : null;
    const rawMetaVersion = metaObj ? metaObj["io.modelcontextprotocol/protocolVersion"] : undefined;
    if (rawMetaVersion !== undefined && typeof rawMetaVersion !== "string") {
      return rpcError(
        id,
        -32022,
        "Unsupported protocol version.",
        { supported: [...MCP_PROTOCOL_VERSIONS] },
        400,
        errorVersion
      );
    }
    const metaVersion = typeof rawMetaVersion === "string" ? rawMetaVersion.trim() : "";

    if (
      (headerVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(headerVersion)) ||
      (metaVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(metaVersion))
    ) {
      const requested =
        (metaVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(metaVersion) ? metaVersion : "") ||
        headerVersion;
      return rpcError(
        id,
        -32022,
        "Unsupported protocol version.",
        { supported: [...MCP_PROTOCOL_VERSIONS], requested },
        400,
        errorVersion
      );
    }
    if (metaVersion && !headerVersion) {
      return rpcError(
        id,
        -32020,
        "Header mismatch: MCP-Protocol-Version header is missing.",
        undefined,
        400,
        errorVersion
      );
    }
    if (headerVersion && metaVersion && headerVersion !== metaVersion) {
      return rpcError(
        id,
        -32020,
        "Header mismatch: MCP-Protocol-Version does not match _meta.",
        undefined,
        400,
        errorVersion
      );
    }
    if (headerVersion) {
      activeVersion = headerVersion;
    }

    // Modern 2026-07-28 requests declaring the version header must mirror method and target name/uri.
    if (headerVersion === MCP_MODERN_PROTOCOL_VERSION) {
      const methodHeader = options?.mcpMethodHeader?.trim() ?? "";
      if (!methodHeader || methodHeader !== msg.method) {
        return rpcError(
          id,
          -32020,
          "Header mismatch: Mcp-Method header must match JSON-RPC method.",
          undefined,
          400,
          activeVersion
        );
      }
      if (msg.method === "tools/call" || msg.method === "prompts/get") {
        const expectedName = typeof params.name === "string" ? params.name.trim() : "";
        const nameHeader = options?.mcpNameHeader?.trim() ?? "";
        if (!nameHeader || !expectedName || nameHeader !== expectedName) {
          return rpcError(
            id,
            -32020,
            "Header mismatch: Mcp-Name header must match params.name.",
            undefined,
            400,
            activeVersion
          );
        }
      } else if (msg.method === "resources/read") {
        const expectedUri = typeof params.uri === "string" ? params.uri.trim() : "";
        const nameHeader = options?.mcpNameHeader?.trim() ?? "";
        if (!nameHeader || !expectedUri || nameHeader !== expectedUri) {
          return rpcError(
            id,
            -32020,
            "Header mismatch: Mcp-Name header must match params.uri.",
            undefined,
            400,
            activeVersion
          );
        }
      }
    }
  }

  // JSON-RPC notifications (no id) return 202 Accepted cleanly with no response body.
  if (!hasId) {
    return { status: 202, headers: { "mcp-protocol-version": activeVersion } };
  }

  const serverCapabilities = {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    extensions: {
      "io.modelcontextprotocol/skills": {},
    },
  };
  const modernCacheFields =
    activeVersion === MCP_MODERN_PROTOCOL_VERSION
      ? { ttlMs: MCP_CACHE_TTL_MS, cacheScope: "public" as const }
      : {};

  if (msg.method === "server/discover") {
    return rpcOk(
      id,
      {
        supportedVersions: [...MCP_PROTOCOL_VERSIONS],
        capabilities: serverCapabilities,
        instructions: MCP_SERVER_INSTRUCTIONS,
        ttlMs: MCP_CACHE_TTL_MS,
        cacheScope: "public",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "gathergate",
            title: "GatherGate",
            version: MCP_SERVER_VERSION,
          },
        },
      },
      activeVersion
    );
  }

  if (msg.method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const negotiated = SUPPORTED_LEGACY_VERSIONS.has(requested)
      ? requested
      : MCP_LEGACY_DEFAULT_VERSION;
    return rpcOk(
      id,
      {
        protocolVersion: negotiated,
        capabilities: serverCapabilities,
        serverInfo: {
          name: "gathergate",
          title: "GatherGate",
          version: MCP_SERVER_VERSION,
        },
        instructions: MCP_SERVER_INSTRUCTIONS,
      },
      negotiated
    );
  }

  if (msg.method === "ping") {
    return rpcOk(id, {}, activeVersion);
  }

  if (msg.method === "tools/list") {
    return rpcOk(
      id,
      {
        ...modernCacheFields,
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      },
      activeVersion
    );
  }

  if (msg.method === "resources/list") {
    const skill = getBundledGatherGateSkill();
    return rpcOk(
      id,
      {
        ...modernCacheFields,
        resources: skill.files.map((f) => ({
          uri: f.uri,
          name: f.name,
          description: f.description,
          mimeType: f.mimeType,
        })),
      },
      activeVersion
    );
  }

  if (msg.method === "resources/read") {
    const uri = typeof params.uri === "string" ? params.uri.trim() : "";
    if (!uri) {
      return rpcError(id, -32602, "Invalid params: uri is required.", undefined, 200, activeVersion);
    }
    const resource = getBundledSkillResource(uri);
    if (!resource) {
      return rpcError(id, -32602, `Resource not found: ${uri}`, undefined, 200, activeVersion);
    }
    return rpcOk(
      id,
      {
        ...modernCacheFields,
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.content,
          },
        ],
      },
      activeVersion
    );
  }

  if (msg.method === "resources/templates/list") {
    return rpcOk(
      id,
      {
        ...modernCacheFields,
        resourceTemplates: [],
      },
      activeVersion
    );
  }

  // SEP-2640 (io.modelcontextprotocol/skills) progressive-disclosure discovery methods
  if (msg.method === "skills/list") {
    const skill = getBundledGatherGateSkill();
    return rpcOk(id, { ...modernCacheFields, skills: [serializeSkillEntry(skill)] }, activeVersion);
  }

  if (msg.method === "skills/get") {
    const uri = typeof params.uri === "string" ? params.uri.trim() : "";
    const skill = getBundledGatherGateSkill();
    if (uri !== skill.uri && uri !== `skill://${skill.name}`) {
      return rpcError(id, -32602, `Skill not found: ${uri || "(empty)"}`, undefined, 200, activeVersion);
    }
    return rpcOk(id, { ...modernCacheFields, skill: serializeSkillEntry(skill) }, activeVersion);
  }

  if (msg.method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    if (
      params.arguments !== undefined &&
      (params.arguments === null || typeof params.arguments !== "object" || Array.isArray(params.arguments))
    ) {
      return rpcError(id, -32602, "Invalid params: arguments must be a JSON object.", undefined, 200, activeVersion);
    }
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      return rpcError(id, -32602, `Unknown tool: ${toolName}`, undefined, 200, activeVersion);
    }
    if (!auth.scopes.has(tool.requiredScope)) {
      return rpcError(
        id,
        -32003,
        `API key lacks required scope "${tool.requiredScope}".`,
        { requiredScope: tool.requiredScope },
        200,
        activeVersion
      );
    }

    const result = await executeMcpTool(tool.name, args, auth, deps);
    return rpcOk(id, result, activeVersion);
  }

  const unknownMethodStatus = activeVersion === MCP_MODERN_PROTOCOL_VERSION ? 404 : 200;
  return rpcError(id, -32601, `Method not found: ${msg.method}`, undefined, unknownMethodStatus, activeVersion);
}

async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  auth: McpAuthContext,
  deps: McpHandlerDeps
): Promise<Record<string, unknown>> {
  const { store, config, nowFn } = deps;
  const actorLabel = `mcp:${auth.apiKey.id}`;

  if (name === "list_templates") {
    const templates = store.listTemplates(auth.workspace.id).map((t) => {
      const items = JSON.parse(t.items_json) as TemplateItemSpec[];
      return {
        template_id: t.id,
        name: t.name,
        description: t.description,
        is_builtin: t.is_builtin === 1,
        item_count: items.length,
        has_sensitive_items: items.some((i) => SENSITIVE_VALIDATORS.has(i.validator)),
        items: items.map((i) => ({
          section: i.section,
          label: i.label,
          kind: i.kind,
          required: Boolean(i.required),
          validator: i.validator || "none",
        })),
      };
    });
    return toolOk({ workspace_name: auth.workspace.name, templates });
  }

  if (name === "list_requests") {
    const statusFilter = typeof args.status === "string" ? args.status.trim() : "";
    if (args.status !== undefined && (typeof args.status !== "string" || !VALID_REQUEST_STATUSES.has(statusFilter))) {
      return toolErr(`Invalid status filter "${String(args.status)}".`);
    }
    if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) {
      return toolErr("limit must be an integer between 1 and 50.");
    }
    const limit = args.limit === undefined ? 20 : args.limit;

    const rows = store
      .listRequests(auth.workspace.id)
      .filter((r) => !statusFilter || r.status === statusFilter)
      .slice(0, limit);

    return toolOk({
      workspace_name: auth.workspace.name,
      count: rows.length,
      requests: rows.map((r) => serializeRequestSummary(r, config.baseUrl)),
    });
  }

  if (name === "get_request_status") {
    const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
    if (!requestId) return toolErr("request_id is required.");

    const req = store.getRequestById(auth.workspace.id, requestId);
    if (!req) return toolErr("Request not found.");

    const rawItems = store.listRequestItems(req.id);
    const uploads = store.listUploadsForRequest(req.id);
    const uploadCounts = new Map<string, number>();
    for (const u of uploads) {
      uploadCounts.set(u.request_item_id, (uploadCounts.get(u.request_item_id) ?? 0) + 1);
    }

    // Hard zero-PII boundary: never decrypt item values, notes, filenames, or magic tokens.
    const items = rawItems.map((item) => ({
      item_id: item.id,
      position: item.position,
      section: item.section,
      label: item.label,
      kind: item.kind,
      required: item.required === 1,
      validator: item.validator,
      is_sensitive: SENSITIVE_VALIDATORS.has(item.validator),
      status: item.status,
      client_na: item.client_na === 1,
      has_value: Boolean(item.value_encrypted),
      has_client_note: Boolean(item.client_note_encrypted),
      upload_count: uploadCounts.get(item.id) ?? 0,
      updated_at: item.updated_at,
    }));

    const isPurged = req.status === "purged";
    return toolOk({
      request_id: req.id,
      title: req.title,
      client_name: isPurged ? null : req.client_name,
      client_email_masked: isPurged ? null : maskEmail(req.client_email),
      status: req.status,
      require_otp: req.require_otp === 1,
      due_at: req.due_at,
      created_at: req.created_at,
      last_opened_at: req.last_opened_at,
      reminders_sent: req.reminders_sent,
      max_reminders: req.max_reminders,
      reminders_paused: req.reminders_paused === 1,
      next_reminder_at: req.next_reminder_at,
      completed_at: req.completed_at,
      purge_at: req.purge_at,
      review_url: `${config.baseUrl}/requests/${req.id}`,
      counts: {
        total: items.length,
        pending: items.filter((i) => i.status === "pending").length,
        submitted: items.filter((i) => i.status === "submitted").length,
        approved: items.filter((i) => i.status === "approved").length,
        rejected: items.filter((i) => i.status === "rejected").length,
      },
      items,
    });
  }

  if (name === "list_overdue_requests") {
    if (
      args.within_days !== undefined &&
      (typeof args.within_days !== "number" || !Number.isInteger(args.within_days) || args.within_days < 0 || args.within_days > 30)
    ) {
      return toolErr("within_days must be an integer between 0 and 30.");
    }
    if (
      args.limit !== undefined &&
      (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)
    ) {
      return toolErr("limit must be an integer between 1 and 50.");
    }
    const withinDays = args.within_days === undefined ? 0 : args.within_days;
    const limit = args.limit === undefined ? 50 : args.limit;
    const nowMs = nowFn();
    const cutoffIso = new Date(nowMs + withinDays * 86400_000).toISOString();
    const nowIso = new Date(nowMs).toISOString();

    const rows = store
      .listRequests(auth.workspace.id)
      .filter(
        (r) =>
          (r.status === "open" || r.status === "in_review") &&
          Boolean(r.due_at) &&
          r.due_at! <= cutoffIso
      )
      .slice(0, limit);

    const overdue = rows.map((r) => {
      const items = store.listRequestItems(r.id);
      const outstandingLabels = items
        .filter((i) => i.status === "pending" || i.status === "rejected")
        .map((i) => ({ label: i.label, status: i.status, required: i.required === 1 }));
      return {
        ...serializeRequestSummary(r, config.baseUrl),
        is_overdue: r.due_at! <= nowIso,
        outstanding_items: outstandingLabels,
      };
    });

    return toolOk({
      as_of: nowIso,
      within_days: withinDays,
      count: overdue.length,
      requests: overdue,
    });
  }

  if (name === "create_request") {
    if (
      auth.workspace.max_active_requests > 0 &&
      store.countActiveRequests(auth.workspace.id, true) >= auth.workspace.max_active_requests
    ) {
      return toolErr(
        `Active request cap (${auth.workspace.max_active_requests}) reached on current plan.`
      );
    }

    const templateId = typeof args.template_id === "string" ? args.template_id.trim() : "";
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const clientName = typeof args.client_name === "string" ? args.client_name.trim() : "";
    const clientEmail = typeof args.client_email === "string" ? args.client_email.trim().toLowerCase() : "";
    const welcomeNote =
      typeof args.welcome_note === "string" && args.welcome_note.trim()
        ? args.welcome_note.trim()
        : null;

    if (
      !templateId ||
      !title ||
      title.length > 200 ||
      hasCrLf(title) ||
      !clientName ||
      clientName.length > 120 ||
      hasCrLf(clientName) ||
      !isValidEmailAddress(clientEmail) ||
      (welcomeNote && welcomeNote.length > 2000)
    ) {
      return toolErr(
        "Provide valid template_id, title (1-200 chars), client_name (1-120 chars), and client_email."
      );
    }

    let dueAt: string | null = null;
    if (args.due_at !== undefined && args.due_at !== null && args.due_at !== "") {
      if (typeof args.due_at !== "string") return toolErr("due_at must be an ISO 8601 string or null.");
      const parsedDue = new Date(args.due_at);
      if (Number.isNaN(parsedDue.getTime())) return toolErr("Invalid due_at timestamp.");
      dueAt = parsedDue.toISOString();
    }

    const template = store.getTemplate(auth.workspace.id, templateId);
    if (!template) return toolErr("Template not found in this workspace.");

    const items = JSON.parse(template.items_json) as TemplateItemSpec[];
    if (!Array.isArray(items) || items.length === 0 || items.some((i) => !isKnownValidator(i.validator || "none"))) {
      return toolErr("Template contains invalid checklist items.");
    }

    if (args.require_otp !== undefined && typeof args.require_otp !== "boolean") {
      return toolErr("require_otp must be a boolean.");
    }
    if (args.send_invite !== undefined && typeof args.send_invite !== "boolean") {
      return toolErr("send_invite must be a boolean.");
    }
    const hasSensitive = items.some((i) => SENSITIVE_VALIDATORS.has(i.validator));
    const requireOtp = args.require_otp !== undefined ? args.require_otp : hasSensitive;
    const sendInvite = args.send_invite !== false;
    const purgeAfterDays = hasSensitive
      ? Math.min(config.defaultPurgeDays, SENSITIVE_DEFAULT_PURGE_DAYS)
      : config.defaultPurgeDays;

    const { request, magicToken } = store.createRequest({
      workspaceId: auth.workspace.id,
      templateId: template.id,
      title,
      clientName,
      clientEmail,
      welcomeNote,
      items,
      requireOtp,
      reminderIntervalDays: 3,
      maxReminders: 4,
      purgeAfterDays,
      dueAt,
      masterKey: config.masterKey,
      actor: "api_key",
      actorBy: actorLabel,
    });

    let inviteSent = false;
    let inviteError: string | undefined;
    if (sendInvite) {
      const portalUrl = `${config.baseUrl}/c/${magicToken}`;
      let rawInviteError: string | undefined;
      try {
        await deps.sendEmail({
          workspace: auth.workspace,
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
            subject: null,
          }),
          kind: "invite",
        });
        inviteSent = true;
      } catch (err) {
        rawInviteError = err instanceof Error ? err.message : String(err);
        inviteError = config.multiTenant
          ? "Invite email failed to send. Check outbound email settings."
          : err instanceof Error
            ? err.message
            : "Invite email failed to send.";
      }

      if (inviteSent) {
        safeLogAudit(store, auth.workspace.id, request.id, "system", "invite.sent", {
          to: clientEmail,
          via: "mcp",
        });
      } else {
        safeLogAudit(store, auth.workspace.id, request.id, "system", "invite.failed", {
          to: clientEmail,
          via: "mcp",
          error: rawInviteError ?? "Invite email failed to send.",
        });
      }
    }

    // Never return raw magicToken or portalUrl into external LLM context.
    return toolOk({
      request_id: request.id,
      title: request.title,
      status: request.status,
      item_count: items.length,
      require_otp: requireOtp,
      due_at: dueAt,
      invite_sent: inviteSent,
      ...(inviteError ? { invite_error: inviteError } : {}),
      review_url: `${config.baseUrl}/requests/${request.id}`,
    });
  }

  if (name === "send_reminder") {
    const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
    if (!requestId) return toolErr("request_id is required.");

    const req = store.getRequestById(auth.workspace.id, requestId);
    if (!req) return toolErr("Request not found.");
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      return toolErr("Checklist is closed.");
    }

    const items = store.listRequestItems(req.id);
    const requiredItems = items.filter((i) => i.required === 1);
    const checkSet = new Set((requiredItems.length > 0 ? requiredItems : items).map((i) => i.id));
    const outstanding = items.filter(
      (i) => (checkSet.has(i.id) || i.status === "rejected") && (i.status === "pending" || i.status === "rejected")
    );
    if (outstanding.length === 0) {
      return toolErr("No outstanding items to remind the client about.");
    }

    const cooldownMs = deps.manualReminderCooldownMs ?? DEFAULT_MANUAL_REMINDER_COOLDOWN_MS;
    if (req.last_manual_reminder_at && cooldownMs > 0) {
      const elapsed = nowFn() - Date.parse(req.last_manual_reminder_at);
      if (elapsed >= 0 && elapsed < cooldownMs) {
        const retryAfterSeconds = Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000));
        return toolErr(`Reminder sent recently. Wait ${retryAfterSeconds} seconds before sending another.`);
      }
    }

    const inFlight = deps.inFlightReminders ?? FALLBACK_IN_FLIGHT_REMINDERS;
    if (inFlight.has(req.id)) {
      return toolErr("A reminder is already being sent for this request. Wait a moment and retry.");
    }
    inFlight.add(req.id);

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
        await deps.sendEmail({
          workspace: auth.workspace,
          workspaceId: auth.workspace.id,
          requestId: req.id,
          to: req.client_email,
          message,
          kind: "reminder",
          isDemo: req.is_demo === 1,
        });
      } catch (err) {
        const detail = config.multiTenant
          ? "Reminder email failed to send. Check outbound email settings."
          : err instanceof Error
            ? err.message
            : "Reminder email failed to send.";
        return toolErr(detail);
      }

      const updated = store.recordManualReminderSent(
        auth.workspace.id,
        req.id,
        actorLabel,
        outstanding.length,
        new Date(nowFn()).toISOString(),
        "api_key"
      );

      return toolOk({
        ok: true,
        request_id: req.id,
        reminders_sent: updated.reminders_sent,
        outstanding_count: outstanding.length,
        next_reminder_at: updated.next_reminder_at,
        review_url: `${config.baseUrl}/requests/${req.id}`,
      });
    } finally {
      inFlight.delete(req.id);
    }
  }

  if (name === "update_due_date") {
    const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
    if (!requestId) return toolErr("request_id is required.");

    const req = store.getRequestById(auth.workspace.id, requestId);
    if (!req) return toolErr("Request not found.");
    if (req.status === "completed" || req.status === "purged" || req.status === "expired") {
      return toolErr("Checklist is closed.");
    }

    let nextDue: string | null;
    if (args.due_at === null || args.due_at === "") {
      nextDue = null;
    } else if (typeof args.due_at === "string") {
      const parsed = new Date(args.due_at);
      if (Number.isNaN(parsed.getTime())) return toolErr("Invalid due_at timestamp.");
      nextDue = parsed.toISOString();
    } else {
      return toolErr("due_at must be an ISO 8601 string or null.");
    }

    store.updateRequestDueAt(auth.workspace.id, req.id, nextDue, actorLabel, "api_key");
    return toolOk({
      ok: true,
      request_id: req.id,
      due_at: nextDue,
      review_url: `${config.baseUrl}/requests/${req.id}`,
    });
  }

  return toolErr(`Unsupported tool: ${name}`);
}
