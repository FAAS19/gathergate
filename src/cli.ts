import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectConfig } from "./config.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  checks: DoctorCheck[];
}

export const SUPPORTED_SETUP_CLIENTS = [
  "antigravity",
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "vscode",
  "windsurf",
  "cline",
  "zed",
] as const;

export type SetupClient = (typeof SUPPORTED_SETUP_CLIENTS)[number];
export type SetupTransport = "stdio" | "http";

const MCP_MODERN_VERSION = "2026-07-28";

export function resolvePackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export function getPackageVersion(): string {
  try {
    const pkgPath = path.join(resolvePackageRoot(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL; expected http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL protocol "${parsed.protocol}"; expected http:// or https://.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL must not include embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("URL must not include query parameters or fragments.");
  }
  const withoutTrailing = parsed.toString().replace(/\/+$/, "");
  return withoutTrailing.replace(/\/mcp$/i, "");
}

export function normalizeMcpEndpointUrl(raw: string): string {
  return `${normalizeBaseUrl(raw)}/mcp`;
}

export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

export function isSecureCredentialUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:") return isLoopbackHostname(parsed.hostname);
    return false;
  } catch {
    return false;
  }
}

function inspectSqliteHeaderReadOnly(dbPath: string): { journalMode: "wal" | "rollback"; userVersion: number } {
  const fd = fs.openSync(dbPath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const header = Buffer.alloc(100);
    const bytesRead = fs.readSync(fd, header, 0, 100, 0);
    if (bytesRead < 100 || header.subarray(0, 16).toString("utf8") !== "SQLite format 3\0") {
      throw new Error("file is not a valid SQLite 3 database");
    }
    const rawPageSize = header.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const isPowerOfTwo = pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
    if (!isPowerOfTwo || stat.size < pageSize) {
      throw new Error("SQLite database file is truncated or has an invalid page size");
    }
    const journalMode = header[18] === 2 || header[19] === 2 ? "wal" : "rollback";
    const userVersion = header.readUInt32BE(60);
    return { journalMode, userVersion };
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeBearerToken(raw: string | undefined): { token: string; error?: string } {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { token: "" };
  const token = trimmed.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { token: "" };
  // Fail closed before Headers.append so malformed pastes never echo raw keys in undici TypeErrors.
  if (!/^[\x21-\x7E]+$/.test(token)) {
    return {
      token: "",
      error: "GATHERGATE_API_KEY contains invalid characters; expected printable ASCII without whitespace.",
    };
  }
  return { token };
}

function loadDotEnvIfPresent(): string | null {
  if (typeof process.loadEnvFile !== "function") return null;
  try {
    process.loadEnvFile();
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    return `Failed to load .env: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function parseNodeVersion(version: string): { major: number; minor: number; patch: number } {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
}

export function isSupportedNodeVersion(version: string): boolean {
  const { major, minor } = parseNodeVersion(version);
  return major > 22 || (major === 22 && minor >= 13);
}

export async function runDoctor(options?: {
  url?: string;
  env?: NodeJS.ProcessEnv;
  trustedEnv?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<DoctorReport> {
  const env = options?.env ?? process.env;
  const trustedEnv = options?.trustedEnv;
  const doFetch = options?.fetchImpl ?? fetch;
  const version = getPackageVersion();
  const checks: DoctorCheck[] = [];

  // 1. Node.js runtime check
  const nodeVer = process.versions.node;
  const parsedNode = parseNodeVersion(nodeVer);
  if (!isSupportedNodeVersion(nodeVer)) {
    checks.push({
      name: "node",
      status: "fail",
      detail: `Node.js v${nodeVer} is unsupported; GatherGate requires Node.js >= 22.13 (Node 24+ recommended).`,
    });
  } else if (parsedNode.major < 24) {
    checks.push({
      name: "node",
      status: "warn",
      detail: `Node.js v${nodeVer} supported (Node 24+ recommended for built-in argon2Sync).`,
    });
  } else {
    checks.push({ name: "node", status: "ok", detail: `Node.js v${nodeVer}` });
  }

  // 2. Read-only configuration validation (omit unsafe/credential-bearing URLs from diagnostics)
  const cfg = inspectConfig(env);
  let safeConfigBaseUrl: string | null = null;
  let configBaseUrlError: string | null = null;
  try {
    safeConfigBaseUrl = normalizeBaseUrl(cfg.baseUrl);
  } catch (err) {
    configBaseUrlError = err instanceof Error ? err.message : String(err);
  }
  const configErrors = [...cfg.errors];
  if (configBaseUrlError) {
    configErrors.push(`BASE_URL: ${configBaseUrlError}`);
  }
  if (configErrors.length > 0) {
    checks.push({ name: "config", status: "fail", detail: configErrors.join("; ") });
  } else {
    checks.push({
      name: "config",
      status: "ok",
      detail: `storage=${cfg.storageBackend}, email=${cfg.emailBackend}, bind=${cfg.host}:${cfg.port}, base=${safeConfigBaseUrl}`,
    });
  }

  // 3. DATA_DIR check (read-only; never creates directories)
  if (!fs.existsSync(cfg.dataDir)) {
    let ancestor = path.dirname(cfg.dataDir);
    while (!fs.existsSync(ancestor)) {
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    let ancestorWritable = false;
    try {
      if (fs.existsSync(ancestor) && fs.statSync(ancestor).isDirectory()) {
        fs.accessSync(ancestor, fs.constants.W_OK);
        ancestorWritable = true;
      }
    } catch {
      ancestorWritable = false;
    }
    checks.push({
      name: "data_dir",
      status: ancestorWritable ? "warn" : "fail",
      detail: ancestorWritable
        ? `${cfg.dataDir} does not exist yet (will be created on first serve).`
        : `${cfg.dataDir} does not exist and parent directory is not writable.`,
    });
  } else {
    try {
      const stat = fs.statSync(cfg.dataDir);
      if (!stat.isDirectory()) {
        checks.push({ name: "data_dir", status: "fail", detail: `${cfg.dataDir} is not a directory.` });
      } else {
        fs.accessSync(cfg.dataDir, fs.constants.R_OK | fs.constants.W_OK);
        checks.push({ name: "data_dir", status: "ok", detail: `${cfg.dataDir} is readable and writable.` });
      }
    } catch {
      checks.push({ name: "data_dir", status: "fail", detail: `${cfg.dataDir} is not writable by current user.` });
    }
  }

  // 4. MASTER_KEY readiness (never prints secret values)
  if (cfg.masterKeyState === "env") {
    checks.push({ name: "master_key", status: "ok", detail: "Loaded from MASTER_KEY environment variable." });
  } else if (cfg.masterKeyState === "file") {
    checks.push({
      name: "master_key",
      status: "warn",
      detail: `Using auto-generated key file at ${cfg.masterKeyFilePath}; move value to MASTER_KEY env var for production.`,
    });
  } else if (cfg.masterKeyState === "missing") {
    checks.push({
      name: "master_key",
      status: "warn",
      detail: "MASTER_KEY not set; first boot will auto-generate DATA_DIR/.master.key.",
    });
  } else {
    checks.push({
      name: "master_key",
      status: "fail",
      detail: cfg.masterKeyFilePath
        ? `Invalid key format in ${cfg.masterKeyFilePath}; expected 64 hex characters.`
        : "MASTER_KEY environment variable must be 64 hex characters (32 bytes).",
    });
  }

  // 5. SQLite header check (strictly non-mutating: reads 100-byte header so WAL sidecars are never created)
  if (!fs.existsSync(cfg.dbPath)) {
    checks.push({
      name: "database",
      status: "warn",
      detail: `${cfg.dbPath} not initialised yet (created on first serve).`,
    });
  } else {
    try {
      const dbInfo = inspectSqliteHeaderReadOnly(cfg.dbPath);
      checks.push({
        name: "database",
        status: "ok",
        detail: `${cfg.dbPath} SQLite header valid (journal=${dbInfo.journalMode}, schema_v=${dbInfo.userVersion}).`,
      });
    } catch (err) {
      checks.push({
        name: "database",
        status: "fail",
        detail: `Could not read SQLite database at ${cfg.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 6. Bundled package assets check (UI, SEP-2640 SKILL.md, server.json)
  const pkgRoot = resolvePackageRoot();
  const requiredAssets = [
    path.join(pkgRoot, "client", "dist", "index.html"),
    path.join(pkgRoot, "skills", "gathergate", "SKILL.md"),
    path.join(pkgRoot, "server.json"),
  ];
  const missingAssets = requiredAssets
    .filter((p) => !fs.existsSync(p))
    .map((p) => path.relative(pkgRoot, p));
  if (missingAssets.length > 0) {
    checks.push({
      name: "bundle",
      status: "fail",
      detail: `Missing bundled artefacts: ${missingAssets.join(", ")}. Run npm run build.`,
    });
  } else {
    checks.push({
      name: "bundle",
      status: "ok",
      detail: "Client bundle, skills/gathergate/SKILL.md, and server.json present.",
    });
  }

  // 7. Optional remote / local server health & MCP probe
  const explicitUrl = options?.url?.trim() || env.GATHERGATE_URL?.trim() || "";
  const rawProbeTarget = explicitUrl || cfg.baseUrl;
  let probeBaseUrl: string | null = null;
  try {
    probeBaseUrl = normalizeBaseUrl(rawProbeTarget);
  } catch (err) {
    checks.push({
      name: "remote_health",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let serverHealthy = false;
  if (probeBaseUrl) {
    try {
      const healthRes = await doFetch(`${probeBaseUrl}/healthz`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
      });
      if (healthRes.ok) {
        const body = (await healthRes.json().catch(() => ({}))) as { ok?: boolean; service?: string };
        if (body.ok === true && body.service === "gathergate") {
          serverHealthy = true;
          checks.push({
            name: "remote_health",
            status: "ok",
            detail: `${probeBaseUrl}/healthz returned HTTP 200 (service: gathergate).`,
          });
        } else {
          checks.push({
            name: "remote_health",
            status: "fail",
            detail: `${probeBaseUrl}/healthz returned HTTP ${healthRes.status} but unexpected payload.`,
          });
        }
      } else {
        checks.push({
          name: "remote_health",
          status: explicitUrl ? "fail" : "warn",
          detail: `${probeBaseUrl}/healthz returned HTTP ${healthRes.status}.`,
        });
      }
    } catch {
      checks.push({
        name: "remote_health",
        status: explicitUrl ? "fail" : "warn",
        detail: explicitUrl
          ? `Could not reach ${probeBaseUrl}/healthz.`
          : `No GatherGate server currently listening at ${probeBaseUrl}.`,
      });
    }
  }

  // 8. MCP probe (when server is healthy and GATHERGATE_API_KEY is configured)
  const parsedKey = normalizeBearerToken(env.GATHERGATE_API_KEY);
  const inheritedApiKey = Boolean(trustedEnv?.GATHERGATE_API_KEY?.trim());
  let untrustedDotenvTargetForInheritedKey = false;
  if (trustedEnv && inheritedApiKey && probeBaseUrl && !options?.url?.trim()) {
    const trustedRawTarget = trustedEnv.GATHERGATE_URL?.trim() || inspectConfig(trustedEnv).baseUrl;
    let trustedNormalized: string | null = null;
    try {
      trustedNormalized = normalizeBaseUrl(trustedRawTarget);
    } catch {
      trustedNormalized = null;
    }
    if (trustedNormalized !== probeBaseUrl) {
      untrustedDotenvTargetForInheritedKey = true;
    }
  }

  if (serverHealthy && probeBaseUrl) {
    if (parsedKey.error) {
      checks.push({
        name: "remote_mcp",
        status: "fail",
        detail: parsedKey.error,
      });
    } else if (!parsedKey.token) {
      checks.push({
        name: "remote_mcp",
        status: "warn",
        detail: "GATHERGATE_API_KEY not set; skipping authenticated POST /mcp probe.",
      });
    } else if (untrustedDotenvTargetForInheritedKey) {
      checks.push({
        name: "remote_mcp",
        status: "warn",
        detail:
          "Skipped authenticated POST /mcp probe because target URL came from CWD .env while GATHERGATE_API_KEY was inherited; pass --url explicitly to probe this endpoint.",
      });
    } else if (!isSecureCredentialUrl(probeBaseUrl)) {
      checks.push({
        name: "remote_mcp",
        status: "fail",
        detail:
          "Refusing to send GATHERGATE_API_KEY over cleartext http:// to a non-loopback host; use https://.",
      });
    } else {
      const apiKey = parsedKey.token;
      try {
        const mcpUrl = `${probeBaseUrl}/mcp`;
        const discoverRes = await doFetch(mcpUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_MODERN_VERSION,
            "mcp-method": "server/discover",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (discoverRes.status === 401) {
          checks.push({
            name: "remote_mcp",
            status: "fail",
            detail: "POST /mcp rejected GATHERGATE_API_KEY with HTTP 401 (invalid, expired, or revoked key).",
          });
        } else if (discoverRes.status === 403) {
          checks.push({
            name: "remote_mcp",
            status: "fail",
            detail: 'POST /mcp returned HTTP 403 (ensure API key includes the "mcp:read" scope).',
          });
        } else if (!discoverRes.ok) {
          checks.push({
            name: "remote_mcp",
            status: "fail",
            detail: `POST /mcp server/discover failed with HTTP ${discoverRes.status}.`,
          });
        } else {
          const discoverJson = (await discoverRes.json().catch(() => null)) as {
            error?: { code?: number; message?: string };
            result?: { supportedVersions?: unknown };
          } | null;
          if (!discoverJson || discoverJson.error || !Array.isArray(discoverJson.result?.supportedVersions)) {
            checks.push({
              name: "remote_mcp",
              status: "fail",
              detail:
                typeof discoverJson?.error?.code === "number"
                  ? `POST /mcp server/discover returned JSON-RPC error ${discoverJson.error.code}.`
                  : "POST /mcp server/discover returned an unexpected JSON-RPC payload.",
            });
          } else {
            const toolsRes = await doFetch(mcpUrl, {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": MCP_MODERN_VERSION,
                "mcp-method": "tools/list",
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
              redirect: "error",
              signal: AbortSignal.timeout(5_000),
            });
            const toolsJson = toolsRes.ok
              ? ((await toolsRes.json().catch(() => null)) as {
                  error?: { code?: number; message?: string };
                  result?: { tools?: unknown };
                } | null)
              : null;
            if (!toolsRes.ok) {
              checks.push({
                name: "remote_mcp",
                status: "fail",
                detail: `POST /mcp tools/list failed with HTTP ${toolsRes.status}.`,
              });
            } else if (!toolsJson || toolsJson.error || !Array.isArray(toolsJson.result?.tools)) {
              checks.push({
                name: "remote_mcp",
                status: "fail",
                detail:
                  typeof toolsJson?.error?.code === "number"
                    ? `POST /mcp tools/list returned JSON-RPC error ${toolsJson.error.code}.`
                    : "POST /mcp tools/list returned an unexpected JSON-RPC payload.",
              });
            } else {
              // Allow only standard YYYY-MM-DD protocol dates so untrusted upstream strings cannot leak secrets.
              const safeVersions = discoverJson.result.supportedVersions
                .filter((v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
              const versionsLabel = safeVersions.length > 0 ? safeVersions.join(", ") : `${discoverJson.result.supportedVersions.length} version(s)`;
              const toolCount = toolsJson.result.tools.length;
              checks.push({
                name: "remote_mcp",
                status: "ok",
                detail: `POST /mcp authenticated (${toolCount} tools, protocol versions: ${versionsLabel}).`,
              });
            }
          }
        }
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        checks.push({
          name: "remote_mcp",
          status: "fail",
          detail: isTimeout
            ? "POST /mcp probe timed out."
            : "POST /mcp probe failed (network error or redirect rejected).",
        });
      }
    }
  }

  return {
    ok: !checks.some((c) => c.status === "fail"),
    version,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`GatherGate Doctor (v${report.version})`, ""];
  for (const check of report.checks) {
    const tag = check.status === "ok" ? "[OK]  " : check.status === "warn" ? "[WARN]" : "[FAIL]";
    lines.push(`${tag} ${check.name.padEnd(14)} ${check.detail}`);
  }
  lines.push("");
  lines.push(report.ok ? "Summary: ready." : "Summary: one or more checks failed.");
  return lines.join("\n");
}

export interface McpBridgeOptions {
  url: string;
  apiKey: string;
  timeoutMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
}

/**
 * Stateless stdio-to-HTTP MCP bridge: reads newline-delimited JSON-RPC frames from stdin,
 * forwards them to POST <url>/mcp with Bearer auth and protocol headers, and writes responses
 * strictly to stdout (diagnostics go exclusively to stderr).
 */
export async function runMcpStdioBridge(options: McpBridgeOptions): Promise<number> {
  const endpoint = normalizeMcpEndpointUrl(options.url);
  const parsedKey = normalizeBearerToken(options.apiKey);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(120_000, Math.max(1_000, options.timeoutMs ?? 30_000));

  if (!isSecureCredentialUrl(endpoint)) {
    errorOutput.write(
      "[GatherGate MCP] Refusing to send GATHERGATE_API_KEY over cleartext http:// to a non-loopback host; use https://.\n"
    );
    return 1;
  }
  if (parsedKey.error) {
    errorOutput.write(`[GatherGate MCP] ${parsedKey.error}\n`);
    return 1;
  }
  const token = parsedKey.token;
  if (!token) {
    errorOutput.write(
      "[GatherGate MCP] GATHERGATE_API_KEY is required. Mint a scoped key (mcp:read) in Settings > API Keys.\n"
    );
    return 1;
  }

  let negotiatedVersion: string | null = null;
  let outputClosed = false;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const onOutputError = (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
      outputClosed = true;
      rl.close();
      return;
    }
    errorOutput.write(`[GatherGate MCP] stdout error: ${err.message}\n`);
  };
  output.on("error", onOutputError);

  const writeLine = (payload: Record<string, unknown>) => {
    if (outputClosed) return;
    try {
      output.write(`${JSON.stringify(payload)}\n`);
    } catch {
      outputClosed = true;
      rl.close();
    }
  };

  try {
    for await (const rawLine of rl) {
      if (outputClosed) break;
      const line = rawLine.trim();
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeLine({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: invalid JSON on stdin." },
        });
        continue;
      }

      const isObj = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
      const msg = isObj ? (parsed as Record<string, unknown>) : {};
      const hasId = isObj && Object.prototype.hasOwnProperty.call(msg, "id");
      const rawId = hasId ? msg.id : null;
      const safeId =
        typeof rawId === "string" || typeof rawId === "number" || rawId === null ? rawId : null;
      const method = typeof msg.method === "string" ? msg.method : "";
      const isNotification = isObj && msg.jsonrpc === "2.0" && method.length > 0 && !hasId;
      const expectsResponse = hasId || !isNotification;
      const params =
        msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
          ? (msg.params as Record<string, unknown>)
          : {};
      const metaObj =
        params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
          ? (params._meta as Record<string, unknown>)
          : null;
      const metaVersion =
        metaObj && typeof metaObj["io.modelcontextprotocol/protocolVersion"] === "string"
          ? metaObj["io.modelcontextprotocol/protocolVersion"].trim()
          : "";

      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };

      let effectiveVersion: string | null = null;
      if (method === "server/discover") {
        effectiveVersion = metaVersion || MCP_MODERN_VERSION;
      } else if (method !== "initialize") {
        effectiveVersion = metaVersion || negotiatedVersion;
      }

      if (effectiveVersion) {
        headers["mcp-protocol-version"] = effectiveVersion;
      }
      if (effectiveVersion === MCP_MODERN_VERSION && method) {
        headers["mcp-method"] = method;
        if ((method === "tools/call" || method === "prompts/get") && typeof params.name === "string") {
          headers["mcp-name"] = params.name.trim();
        } else if (method === "resources/read" && typeof params.uri === "string") {
          headers["mcp-name"] = params.uri.trim();
        }
      }

      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(parsed),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });

        const resVersion = res.headers.get("mcp-protocol-version")?.trim();
        if (res.status === 202) {
          continue;
        }

        const text = await res.text();
        let responseJson: Record<string, unknown> | null = null;
        if (text.trim()) {
          try {
            const candidate = JSON.parse(text) as unknown;
            if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
              responseJson = candidate as Record<string, unknown>;
            }
          } catch {
            responseJson = null;
          }
        }

        if (responseJson && responseJson.jsonrpc === "2.0") {
          if (res.ok && method === "initialize") {
            const resultObj = responseJson.result as { protocolVersion?: unknown } | undefined;
            if (typeof resultObj?.protocolVersion === "string" && resultObj.protocolVersion.trim()) {
              negotiatedVersion = resultObj.protocolVersion.trim();
            } else if (resVersion) {
              negotiatedVersion = resVersion;
            }
          } else if (res.ok && method === "server/discover") {
            negotiatedVersion = resVersion || MCP_MODERN_VERSION;
          }
          if (expectsResponse) {
            writeLine(responseJson);
          }
          continue;
        }

        const serverMessage =
          res.status === 401
            ? "Authentication failed (HTTP 401 from MCP endpoint)."
            : res.status === 403
              ? "Forbidden (HTTP 403 from MCP endpoint; check API key scopes)."
              : `Upstream MCP endpoint returned HTTP ${res.status}.`;
        errorOutput.write(`[GatherGate MCP] ${serverMessage}\n`);
        if (expectsResponse) {
          writeLine({
            jsonrpc: "2.0",
            id: safeId,
            error: {
              code: res.status === 401 || res.status === 403 ? -32001 : -32000,
              message: serverMessage,
            },
          });
        }
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        const reason = isTimeout
          ? "Upstream request timed out."
          : "Upstream request failed (network error or redirect rejected).";
        errorOutput.write(`[GatherGate MCP] ${reason}\n`);
        if (expectsResponse) {
          writeLine({
            jsonrpc: "2.0",
            id: safeId,
            error: { code: -32000, message: reason },
          });
        }
      }
    }
  } finally {
    output.removeListener("error", onOutputError);
    rl.close();
  }

  return 0;
}

export interface GeneratedClientSetup {
  client: SetupClient;
  transport: SetupTransport;
  format: "json" | "toml" | "cli" | "text";
  defaultConfigPath: string | null;
  containerKey: "mcpServers" | "servers" | "context_servers" | null;
  snippet: string;
  serverEntry?: Record<string, unknown>;
  vscodeInput?: Record<string, unknown>;
  notes: string[];
}

function resolveDefaultClientConfigPath(
  client: SetupClient,
  platform = process.platform,
  home = os.homedir(),
  env = process.env
): string | null {
  switch (client) {
    case "claude-desktop":
      if (platform === "darwin") {
        return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (platform === "win32") {
        const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(appData, "Claude", "claude_desktop_config.json");
      }
      return path.join(home, ".config", "Claude", "claude_desktop_config.json");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "antigravity":
      return path.join(home, ".gemini", "antigravity", "mcp_config.json");
    case "windsurf":
      return path.join(home, ".codeium", "windsurf", "mcp_config.json");
    case "vscode":
      return path.resolve(".vscode", "mcp.json");
    case "zed":
      if (platform === "win32") {
        const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(appData, "Zed", "settings.json");
      }
      return path.join(home, ".config", "zed", "settings.json");
    case "codex":
      return path.join(env.CODEX_HOME?.trim() || path.join(home, ".codex"), "config.toml");
    case "cline":
    case "claude-code":
      return null;
  }
}

export function generateClientSetup(params: {
  client: SetupClient;
  url: string;
  transport?: SetupTransport;
}): GeneratedClientSetup {
  const baseUrl = normalizeBaseUrl(params.url);
  const mcpUrl = `${baseUrl}/mcp`;
  const transport: SetupTransport =
    params.transport ?? (params.client === "claude-desktop" ? "stdio" : "http");
  const defaultConfigPath = resolveDefaultClientConfigPath(params.client);

  const stdioEntryEnvRef = {
    command: "npx",
    args: ["-y", "gathergate", "mcp"],
    env: {
      GATHERGATE_URL: baseUrl,
      GATHERGATE_API_KEY: "${env:GATHERGATE_API_KEY}",
    },
  };

  if (params.client === "claude-code") {
    const snippet =
      transport === "stdio"
        ? `claude mcp add gathergate -e GATHERGATE_URL=${shellSingleQuote(baseUrl)} -e GATHERGATE_API_KEY="$GATHERGATE_API_KEY" -- npx -y gathergate mcp`
        : `claude mcp add --transport http gathergate \\\n  ${shellSingleQuote(mcpUrl)} \\\n  --header "Authorization: Bearer $GATHERGATE_API_KEY"`;
    return {
      client: params.client,
      transport,
      format: "cli",
      defaultConfigPath: null,
      containerKey: null,
      snippet,
      notes: [
        "Export GATHERGATE_API_KEY in your shell before running the command.",
        "Optional skill install: npx skills add FAAS19/gathergate",
      ],
    };
  }

  if (params.client === "codex") {
    const snippet =
      transport === "stdio"
        ? [
            "[mcp_servers.gathergate]",
            'command = "npx"',
            'args = ["-y", "gathergate", "mcp"]',
            'env_vars = ["GATHERGATE_API_KEY"]',
            "",
            "[mcp_servers.gathergate.env]",
            `GATHERGATE_URL = "${baseUrl}"`,
          ].join("\n")
        : [
            "[mcp_servers.gathergate]",
            `url = "${mcpUrl}"`,
            'bearer_token_env_var = "GATHERGATE_API_KEY"',
          ].join("\n");
    return {
      client: params.client,
      transport,
      format: "toml",
      defaultConfigPath,
      containerKey: null,
      snippet,
      notes: ["Add to ~/.codex/config.toml and export GATHERGATE_API_KEY in your environment."],
    };
  }

  if (params.client === "claude-desktop" && transport === "http") {
    return {
      client: params.client,
      transport,
      format: "text",
      defaultConfigPath: null,
      containerKey: null,
      snippet: [
        "Claude Desktop claude_desktop_config.json only supports local stdio servers.",
        "For direct HTTPS remote connectors, open Claude Desktop > Settings > Connectors:",
        `  Remote MCP URL: ${mcpUrl}`,
        "  Header: Authorization: Bearer <GATHERGATE_API_KEY>",
        "",
        "Or use the built-in stdio bridge (supports --write):",
        `  npx gathergate setup --client claude-desktop --transport stdio --url ${shellSingleQuote(baseUrl)} --write`,
      ].join("\n"),
      notes: [
        "Use --transport stdio for local JSON configuration without mcp-remote.",
      ],
    };
  }

  if (params.client === "vscode") {
    const vscodeInput = {
      type: "promptString",
      id: "gathergate_api_key",
      description: "GatherGate workspace API key (gg_live_...)",
      password: true,
    };
    const serverEntry =
      transport === "stdio"
        ? {
            type: "stdio",
            command: "npx",
            args: ["-y", "gathergate", "mcp"],
            env: {
              GATHERGATE_URL: baseUrl,
              GATHERGATE_API_KEY: "${input:gathergate_api_key}",
            },
          }
        : {
            type: "http",
            url: mcpUrl,
            headers: {
              Authorization: "Bearer ${input:gathergate_api_key}",
            },
          };
    const snippet = JSON.stringify({ inputs: [vscodeInput], servers: { gathergate: serverEntry } }, null, 2);
    return {
      client: params.client,
      transport,
      format: "json",
      defaultConfigPath,
      containerKey: "servers",
      serverEntry,
      vscodeInput,
      snippet,
      notes: ["VS Code prompts securely for your gg_live_... key without writing secrets to disk."],
    };
  }

  if (params.client === "zed") {
    const serverEntry =
      transport === "stdio"
        ? {
            command: "npx",
            args: ["-y", "gathergate", "mcp"],
            env: {
              GATHERGATE_URL: baseUrl,
              GATHERGATE_API_KEY: "gg_live_replace_me",
            },
          }
        : {
            url: mcpUrl,
            headers: {
              Authorization: "Bearer gg_live_replace_me",
            },
          };
    const snippet = JSON.stringify({ context_servers: { gathergate: serverEntry } }, null, 2);
    return {
      client: params.client,
      transport,
      format: "json",
      defaultConfigPath,
      containerKey: "context_servers",
      serverEntry,
      snippet,
      notes: ["Replace gg_live_replace_me with your scoped workspace API key in Zed's local settings.json."],
    };
  }

  let serverEntry: Record<string, unknown>;
  const notes: string[] = [];
  if (params.client === "claude-desktop") {
    serverEntry = {
      command: "npx",
      args: ["-y", "gathergate", "mcp"],
      env: {
        GATHERGATE_URL: baseUrl,
        GATHERGATE_API_KEY: "gg_live_replace_me",
      },
    };
    notes.push(
      "Uses GatherGate's built-in stdio bridge (zero mcp-remote required). Replace gg_live_replace_me in your local config file (never commit it)."
    );
  } else if (transport === "stdio") {
    serverEntry = stdioEntryEnvRef;
    notes.push("Export GATHERGATE_API_KEY in your environment before launching the client.");
  } else if (params.client === "antigravity" || params.client === "windsurf") {
    serverEntry = {
      serverUrl: mcpUrl,
      headers: { Authorization: "Bearer ${env:GATHERGATE_API_KEY}" },
    };
    notes.push("Export GATHERGATE_API_KEY in your environment before launching the client.");
  } else if (params.client === "cline") {
    serverEntry = {
      type: "streamableHttp",
      url: mcpUrl,
      headers: { Authorization: "Bearer ${env:GATHERGATE_API_KEY}" },
    };
    notes.push("Pass --config-path <path-to-cline_mcp_settings.json> if using --write.");
  } else {
    // cursor
    serverEntry = {
      url: mcpUrl,
      headers: { Authorization: "Bearer ${env:GATHERGATE_API_KEY}" },
    };
    notes.push("Export GATHERGATE_API_KEY in your environment before launching Cursor.");
  }

  const snippet = JSON.stringify({ mcpServers: { gathergate: serverEntry } }, null, 2);
  return {
    client: params.client,
    transport,
    format: "json",
    defaultConfigPath,
    containerKey: "mcpServers",
    serverEntry,
    snippet,
    notes,
  };
}

function isPlaceholderCredential(value: string): boolean {
  const trimmed = value.trim();
  return (
    !trimmed ||
    trimmed === "gg_live_replace_me" ||
    trimmed === "Bearer gg_live_replace_me" ||
    trimmed.includes("${")
  );
}

function canonicalExactUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Invalid endpoint URL");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function preserveExistingCredential(
  existingEntry: unknown,
  nextEntry: Record<string, unknown>
): Record<string, unknown> {
  if (!existingEntry || typeof existingEntry !== "object" || Array.isArray(existingEntry)) {
    return nextEntry;
  }
  const prev = existingEntry as Record<string, unknown>;
  const cloned: Record<string, unknown> = { ...nextEntry };

  // Preserve stdio GATHERGATE_API_KEY only for the exact same endpoint URL.
  const nextEnv =
    cloned.env && typeof cloned.env === "object" && !Array.isArray(cloned.env)
      ? ({ ...(cloned.env as Record<string, unknown>) } as Record<string, unknown>)
      : null;
  const prevEnv =
    prev.env && typeof prev.env === "object" && !Array.isArray(prev.env)
      ? (prev.env as Record<string, unknown>)
      : null;
  if (
    typeof cloned.command === "string" &&
    typeof prev.command === "string" &&
    nextEnv &&
    prevEnv &&
    nextEnv.GATHERGATE_API_KEY === "gg_live_replace_me" &&
    typeof nextEnv.GATHERGATE_URL === "string" &&
    typeof prevEnv.GATHERGATE_URL === "string" &&
    typeof prevEnv.GATHERGATE_API_KEY === "string" &&
    !isPlaceholderCredential(prevEnv.GATHERGATE_API_KEY)
  ) {
    try {
      if (canonicalExactUrl(prevEnv.GATHERGATE_URL) === canonicalExactUrl(nextEnv.GATHERGATE_URL)) {
        nextEnv.GATHERGATE_API_KEY = prevEnv.GATHERGATE_API_KEY;
        cloned.env = nextEnv;
      }
    } catch {
      // Ignore invalid existing URL; do not carry credentials across endpoints.
    }
  }

  // Preserve HTTP Authorization header (case-insensitive lookup) only for the exact same endpoint URL.
  const nextHeaders =
    cloned.headers && typeof cloned.headers === "object" && !Array.isArray(cloned.headers)
      ? ({ ...(cloned.headers as Record<string, unknown>) } as Record<string, unknown>)
      : null;
  const prevHeaders =
    prev.headers && typeof prev.headers === "object" && !Array.isArray(prev.headers)
      ? (prev.headers as Record<string, unknown>)
      : null;
  const prevAuthEntry = prevHeaders
    ? Object.entries(prevHeaders).find(([k]) => k.toLowerCase() === "authorization")?.[1]
    : undefined;
  if (
    typeof cloned.url === "string" &&
    typeof prev.url === "string" &&
    nextHeaders &&
    nextHeaders.Authorization === "Bearer gg_live_replace_me" &&
    typeof prevAuthEntry === "string" &&
    !isPlaceholderCredential(prevAuthEntry)
  ) {
    try {
      if (canonicalExactUrl(prev.url) === canonicalExactUrl(cloned.url)) {
        nextHeaders.Authorization = prevAuthEntry;
        cloned.headers = nextHeaders;
      }
    } catch {
      // Ignore invalid existing URL; do not carry credentials across endpoints.
    }
  }

  return cloned;
}

export function writeClientConfig(setup: GeneratedClientSetup, targetPath: string): void {
  if (setup.format !== "json" || !setup.containerKey || !setup.serverEntry) {
    throw new Error(
      `--write supports JSON MCP configs only. Copy the generated ${setup.format.toUpperCase()} instructions for ${setup.client}.`
    );
  }

  const resolvedPath = path.resolve(targetPath);
  let root: Record<string, unknown> = {};
  let existingStat: fs.Stats | null = null;
  try {
    existingStat = fs.lstatSync(resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw err;
  }
  if (existingStat) {
    if (existingStat.isSymbolicLink()) {
      throw new Error(
        `Refusing to overwrite symlink at ${resolvedPath}; edit the symlink target directly.`
      );
    }
    if (!existingStat.isFile()) {
      throw new Error(`Target path ${resolvedPath} is not a regular file.`);
    }
    const raw = fs.readFileSync(resolvedPath, "utf8").trim();
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `Existing config at ${resolvedPath} is not valid JSON; refusing to overwrite.`
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Existing config at ${resolvedPath} must be a JSON object.`);
      }
      root = parsed as Record<string, unknown>;
    }
  }

  const existingContainer = root[setup.containerKey];
  if (
    existingContainer !== undefined &&
    (!existingContainer || typeof existingContainer !== "object" || Array.isArray(existingContainer))
  ) {
    throw new Error(`Existing "${setup.containerKey}" in ${resolvedPath} is not a JSON object.`);
  }

  if (setup.vscodeInput) {
    if (root.inputs !== undefined && !Array.isArray(root.inputs)) {
      throw new Error(`Existing "inputs" in ${resolvedPath} is not a JSON array.`);
    }
    const existingInputs = Array.isArray(root.inputs) ? [...root.inputs] : [];
    const alreadyHas = existingInputs.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as { id?: unknown }).id === setup.vscodeInput!.id
    );
    if (!alreadyHas) {
      existingInputs.push(setup.vscodeInput);
    }
    root.inputs = existingInputs;
  }

  const containerRecord = (existingContainer as Record<string, unknown> | undefined) ?? {};
  const mergedServerEntry = preserveExistingCredential(containerRecord.gathergate, setup.serverEntry);

  root[setup.containerKey] = {
    ...containerRecord,
    gathergate: mergedServerEntry,
  };

  const parentDir = path.dirname(resolvedPath);
  fs.mkdirSync(parentDir, { recursive: true });
  const tmpPath = `${resolvedPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmpPath, resolvedPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors on failed atomic write.
    }
    throw err;
  }
}

export function formatHelpText(): string {
  return [
    `GatherGate v${getPackageVersion()} - self-hosted client document checklist & metadata-only MCP server`,
    "",
    "Usage:",
    "  gathergate [serve] [--port <port>] [--host <host>] [--data-dir <dir>]",
    "  gathergate doctor [--url <url>] [--json]",
    "  gathergate mcp [--url <url>] [--timeout <ms>]",
    "  gathergate setup [--client <name>] [--url <url>] [--transport <stdio|http>] [--write] [--config-path <path>]",
    "  gathergate --help | --version",
    "",
    "Commands:",
    "  serve   Start the HTTP server (default when no subcommand is given).",
    "  doctor  Run read-only environment, storage, SQLite, and MCP diagnostics.",
    "  mcp     Run the zero-dependency stdio-to-HTTP MCP bridge (uses GATHERGATE_URL & GATHERGATE_API_KEY).",
    "  setup   Print (or with --write, safely merge) MCP client config.",
    `          Clients: ${SUPPORTED_SETUP_CLIENTS.join(", ")}`,
    "",
    "Examples:",
    "  npx gathergate",
    "  npx gathergate doctor --url https://intake.yourfirm.com.au",
    "  npx gathergate setup --client claude-desktop --url http://127.0.0.1:3080",
    "  GATHERGATE_URL=http://127.0.0.1:3080 GATHERGATE_API_KEY=gg_live_... npx gathergate mcp",
  ].join("\n");
}

export async function runCli(
  argv: string[],
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  }
): Promise<number> {
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;
  const env = io?.env ?? process.env;

  const first = argv[0];
  if (first === "-h" || first === "--help" || first === "help") {
    stdout.write(`${formatHelpText()}\n`);
    return 0;
  }
  if (first === "-v" || first === "--version" || first === "version") {
    stdout.write(`${getPackageVersion()}\n`);
    return 0;
  }

  // Support alias `gathergate mcp setup ...` alongside `gathergate setup ...`.
  let command: string;
  let rest: string[];
  if (!first || first.startsWith("-")) {
    command = "serve";
    rest = argv;
  } else if (first === "mcp" && argv[1] === "setup") {
    command = "setup";
    rest = argv.slice(2);
  } else {
    command = first;
    rest = argv.slice(1);
  }

  if (command === "serve") {
    let values: { port?: string; host?: string; "data-dir"?: string; help?: boolean };
    try {
      const parsed = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          port: { type: "string", short: "p" },
          host: { type: "string" },
          "data-dir": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });
      values = parsed.values;
    } catch (err) {
      stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\nRun "gathergate --help" for usage.\n`);
      return 1;
    }
    if (values.help) {
      stdout.write(`${formatHelpText()}\n`);
      return 0;
    }
    if (!io?.env) {
      const dotenvErr = loadDotEnvIfPresent();
      if (dotenvErr) {
        stderr.write(`[GatherGate] ${dotenvErr}\n`);
        return 1;
      }
    }
    try {
      const { startServer } = await import("./server.js");
      startServer({
        port: values.port,
        host: values.host,
        dataDir: values["data-dir"],
      });
      return 0;
    } catch (err) {
      stderr.write(`[GatherGate] ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (command === "doctor") {
    let values: { url?: string; json?: boolean; help?: boolean };
    try {
      const parsed = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          url: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
      values = parsed.values;
    } catch (err) {
      stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\nRun "gathergate --help" for usage.\n`);
      return 1;
    }
    if (values.help) {
      stdout.write(`${formatHelpText()}\n`);
      return 0;
    }
    let preDotenvEnv: NodeJS.ProcessEnv | undefined;
    if (!io?.env) {
      preDotenvEnv = { ...process.env };
      const dotenvErr = loadDotEnvIfPresent();
      if (dotenvErr) {
        stderr.write(`[GatherGate] ${dotenvErr}\n`);
        return 1;
      }
    }
    const report = await runDoctor({
      url: values.url,
      env: io?.env ?? process.env,
      trustedEnv: preDotenvEnv,
      fetchImpl: io?.fetchImpl,
    });
    stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctorReport(report)}\n`);
    return report.ok ? 0 : 1;
  }

  if (command === "mcp") {
    let values: { url?: string; timeout?: string; help?: boolean };
    try {
      const parsed = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          url: { type: "string" },
          timeout: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });
      values = parsed.values;
    } catch (err) {
      stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\nRun "gathergate --help" for usage.\n`);
      return 1;
    }
    if (values.help) {
      stdout.write(`${formatHelpText()}\n`);
      return 0;
    }
    const rawUrl = values.url?.trim() || env.GATHERGATE_URL?.trim() || "http://127.0.0.1:3080";
    let timeoutMs: number | undefined;
    if (values.timeout !== undefined) {
      if (!/^\d+$/.test(values.timeout.trim())) {
        stderr.write("[GatherGate MCP] --timeout must be a positive integer in milliseconds.\n");
        return 1;
      }
      timeoutMs = Number.parseInt(values.timeout.trim(), 10);
    }
    try {
      normalizeMcpEndpointUrl(rawUrl);
    } catch (err) {
      stderr.write(`[GatherGate MCP] ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return runMcpStdioBridge({
      url: rawUrl,
      apiKey: env.GATHERGATE_API_KEY || "",
      timeoutMs,
      input: io?.stdin,
      output: stdout,
      errorOutput: stderr,
      fetchImpl: io?.fetchImpl,
    });
  }

  if (command === "setup") {
    let values: {
      client?: string;
      url?: string;
      transport?: string;
      write?: boolean;
      "config-path"?: string;
      help?: boolean;
    };
    try {
      const parsed = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          client: { type: "string", short: "c" },
          url: { type: "string" },
          transport: { type: "string", short: "t" },
          write: { type: "boolean" },
          "config-path": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });
      values = parsed.values;
    } catch (err) {
      stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\nRun "gathergate --help" for usage.\n`);
      return 1;
    }
    if (values.help) {
      stdout.write(`${formatHelpText()}\n`);
      return 0;
    }
    const rawClient = (values.client || "claude-desktop").trim().toLowerCase();
    if (!(SUPPORTED_SETUP_CLIENTS as readonly string[]).includes(rawClient)) {
      stderr.write(
        `Unknown --client "${values.client}". Supported clients: ${SUPPORTED_SETUP_CLIENTS.join(", ")}\n`
      );
      return 1;
    }
    const client = rawClient as SetupClient;

    let transport: SetupTransport | undefined;
    if (values.transport !== undefined) {
      const t = values.transport.trim().toLowerCase();
      if (t !== "stdio" && t !== "http") {
        stderr.write(`Invalid --transport "${values.transport}". Expected "stdio" or "http".\n`);
        return 1;
      }
      transport = t;
    }

    const rawUrl = values.url?.trim() || env.GATHERGATE_URL?.trim() || "http://127.0.0.1:3080";
    let setup: GeneratedClientSetup;
    try {
      setup = generateClientSetup({ client, url: rawUrl, transport });
    } catch (err) {
      stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }

    if (values.write) {
      const targetPath = values["config-path"]?.trim() || setup.defaultConfigPath;
      if (setup.format !== "json") {
        stderr.write(
          `--write only supports JSON configs. Paste the snippet below for ${setup.client}:\n\n`
        );
        stdout.write(`${setup.snippet}\n`);
        return 1;
      }
      if (!targetPath) {
        stderr.write(
          `Pass --config-path <path> when using --write with ${setup.client}.\n`
        );
        return 1;
      }
      try {
        writeClientConfig(setup, targetPath);
      } catch (err) {
        stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      stdout.write(`Updated ${path.resolve(targetPath)} with GatherGate (${setup.transport}) MCP config.\n`);
      for (const note of setup.notes) {
        stdout.write(`Note: ${note}\n`);
      }
      return 0;
    }

    const header = setup.defaultConfigPath
      ? `GatherGate MCP setup for ${setup.client} (${setup.transport}, default path: ${setup.defaultConfigPath})`
      : `GatherGate MCP setup for ${setup.client} (${setup.transport})`;
    stdout.write(`${header}\n\n${setup.snippet}\n`);
    if (setup.notes.length > 0) {
      stdout.write("\n");
      for (const note of setup.notes) {
        stdout.write(`Note: ${note}\n`);
      }
    }
    return 0;
  }

  stderr.write(`Unknown command "${command}". Run "gathergate --help" for usage.\n`);
  return 1;
}
