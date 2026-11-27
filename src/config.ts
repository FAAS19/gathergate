import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StorageBackend = "local" | "s3";
export type EmailBackend = "console" | "smtp" | "resend";

export const SENSITIVE_DEFAULT_PURGE_DAYS = 14;

export interface AppConfig {
  port: number;
  host: string;
  baseUrl: string;
  dataDir: string;
  dbPath: string;
  masterKey: Buffer;
  masterKeySource: "env" | "file";
  masterKeyFilePath?: string;
  trustProxy: boolean;
  multiTenant: boolean;
  freeMaxActiveRequests: number;
  freeMaxStorageBytes: number;
  storageBackend: StorageBackend;
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  emailBackend: EmailBackend;
  emailFrom: string;
  resendApiKey?: string;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  cronIntervalMinutes: number;
  defaultPurgeDays: number;
  nodeEnv: string;
}

function parseBool(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val === "") return fallback;
  return ["1", "true", "yes", "on"].includes(val.toLowerCase());
}

function parseIntSafe(val: string | undefined, fallback: number): number {
  if (val === undefined || val === "") return fallback;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readValidatedKeyFile(filePath: string): Buffer {
  const stored = fs.readFileSync(filePath, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(stored)) {
    throw new Error(`Invalid MASTER_KEY file at ${filePath}; expected 64 hex characters.`);
  }
  return Buffer.from(stored, "hex");
}

function resolveMasterKey(
  env: NodeJS.ProcessEnv,
  dataDir: string
): { key: Buffer; source: "env" | "file"; filePath?: string } {
  const raw = env.MASTER_KEY?.trim();
  if (raw) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error("MASTER_KEY must be a 64-character hex string (32 bytes)");
    }
    return { key: Buffer.from(raw, "hex"), source: "env" };
  }
  // Auto-generate and persist in dataDir so single-command Docker starts cleanly; fail closed if file is corrupt.
  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dataDir, ".master.key");
  if (fs.existsSync(keyFile)) {
    return { key: readValidatedKeyFile(keyFile), source: "file", filePath: keyFile };
  }
  const legacyKeyFile = path.join(dataDir, ".dev-master.key");
  if (fs.existsSync(legacyKeyFile)) {
    return { key: readValidatedKeyFile(legacyKeyFile), source: "file", filePath: legacyKeyFile };
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString("hex") + "\n", { mode: 0o600 });
  return { key: generated, source: "file", filePath: keyFile };
}

function parsePort(val: string | undefined, fallback: number): number {
  if (val === undefined || val === "") return fallback;
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid PORT "${val}"; expected an integer between 0 and 65535.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid PORT "${val}"; expected an integer between 0 and 65535.`);
  }
  return parsed;
}

function resolveDefaultBaseUrl(env: NodeJS.ProcessEnv, host: string, port: number): string {
  const explicit = env.BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const renderUrl = env.RENDER_EXTERNAL_URL?.trim();
  if (renderUrl) return renderUrl.replace(/\/+$/, "");

  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayDomain) {
    const withScheme = /^https?:\/\//i.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`;
    return withScheme.replace(/\/+$/, "");
  }

  const flyApp = env.FLY_APP_NAME?.trim();
  if (flyApp) return `https://${flyApp}.fly.dev`;

  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return `http://localhost:${port}`;
  }
  const cleanHost = host.replace(/^\[|\]$/g, "");
  const formattedHost = cleanHost.includes(":") ? `[${cleanHost}]` : cleanHost;
  return `http://${formattedHost}:${port}`;
}

export interface ConfigInspection {
  dataDir: string;
  dbPath: string;
  host: string;
  port: number | null;
  baseUrl: string;
  storageBackend: StorageBackend | null;
  emailBackend: EmailBackend | null;
  masterKeyState: "env" | "file" | "missing" | "invalid";
  masterKeyFilePath?: string;
  errors: string[];
}

/** Read-only config inspection for CLI diagnostics (never creates directories or key files). */
export function inspectConfig(env: NodeJS.ProcessEnv = process.env): ConfigInspection {
  const errors: string[] = [];
  const dataDir = path.resolve(env.DATA_DIR || "./data");
  const dbPath = env.DB_PATH || path.join(dataDir, "gathergate.sqlite");
  const host = (env.HOST || "127.0.0.1").trim();

  let port: number | null = 3080;
  try {
    port = parsePort(env.PORT, 3080);
  } catch (err) {
    port = null;
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const rawStorage = (env.STORAGE_BACKEND || "local").trim().toLowerCase();
  let storageBackend: StorageBackend | null = null;
  if (rawStorage === "local" || rawStorage === "s3") {
    storageBackend = rawStorage;
  } else {
    errors.push(`Invalid STORAGE_BACKEND "${env.STORAGE_BACKEND}"; expected "local" or "s3".`);
  }

  const rawEmail = (env.EMAIL_BACKEND || "console").trim().toLowerCase();
  let emailBackend: EmailBackend | null = null;
  if (rawEmail === "console" || rawEmail === "smtp" || rawEmail === "resend") {
    emailBackend = rawEmail;
  } else {
    errors.push(`Invalid EMAIL_BACKEND "${env.EMAIL_BACKEND}"; expected "console", "smtp", or "resend".`);
  }

  let masterKeyState: ConfigInspection["masterKeyState"] = "missing";
  let masterKeyFilePath: string | undefined;
  const rawKey = env.MASTER_KEY?.trim();
  if (rawKey) {
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      masterKeyState = "env";
    } else {
      masterKeyState = "invalid";
      errors.push("MASTER_KEY must be a 64-character hex string (32 bytes)");
    }
  } else {
    const keyFile = path.join(dataDir, ".master.key");
    const legacyKeyFile = path.join(dataDir, ".dev-master.key");
    const candidate = fs.existsSync(keyFile)
      ? keyFile
      : fs.existsSync(legacyKeyFile)
        ? legacyKeyFile
        : undefined;
    if (candidate) {
      masterKeyFilePath = candidate;
      try {
        readValidatedKeyFile(candidate);
        masterKeyState = "file";
      } catch (err) {
        masterKeyState = "invalid";
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (storageBackend === "s3") {
    if (
      !env.S3_ENDPOINT?.trim() ||
      !env.S3_BUCKET?.trim() ||
      !env.S3_ACCESS_KEY_ID?.trim() ||
      !env.S3_SECRET_ACCESS_KEY?.trim()
    ) {
      errors.push("S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY");
    }
  }
  if (emailBackend === "resend" && !env.RESEND_API_KEY?.trim()) {
    errors.push("RESEND_API_KEY is required when EMAIL_BACKEND=resend");
  }
  if (emailBackend === "smtp" && !env.SMTP_HOST?.trim()) {
    errors.push("SMTP_HOST is required when EMAIL_BACKEND=smtp");
  }

  return {
    dataDir,
    dbPath,
    host,
    port,
    baseUrl: resolveDefaultBaseUrl(env, host, port ?? 3080),
    storageBackend,
    emailBackend,
    masterKeyState,
    masterKeyFilePath,
    errors,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR || "./data");
  const dbPath = env.DB_PATH || path.join(dataDir, "gathergate.sqlite");
  const rawStorage = (env.STORAGE_BACKEND || "local").trim().toLowerCase();
  if (rawStorage !== "local" && rawStorage !== "s3") {
    throw new Error(`Invalid STORAGE_BACKEND "${env.STORAGE_BACKEND}"; expected "local" or "s3".`);
  }
  const storageBackend: StorageBackend = rawStorage;

  const rawEmail = (env.EMAIL_BACKEND || "console").trim().toLowerCase();
  if (rawEmail !== "console" && rawEmail !== "smtp" && rawEmail !== "resend") {
    throw new Error(`Invalid EMAIL_BACKEND "${env.EMAIL_BACKEND}"; expected "console", "smtp", or "resend".`);
  }
  const emailBackend: EmailBackend = rawEmail;

  const port = parsePort(env.PORT, 3080);
  const host = (env.HOST || "127.0.0.1").trim();
  const resolvedKey = resolveMasterKey(env, dataDir);

  const config: AppConfig = {
    port,
    host,
    baseUrl: resolveDefaultBaseUrl(env, host, port),
    dataDir,
    dbPath,
    masterKey: resolvedKey.key,
    masterKeySource: resolvedKey.source,
    masterKeyFilePath: resolvedKey.filePath,
    trustProxy: parseBool(env.TRUST_PROXY, false),
    multiTenant: parseBool(env.MULTI_TENANT, false),
    freeMaxActiveRequests: parseIntSafe(env.FREE_MAX_ACTIVE_REQUESTS, 5),
    freeMaxStorageBytes: parseIntSafe(env.FREE_MAX_STORAGE_BYTES, 1024 * 1024 * 1024),
    storageBackend,
    emailBackend,
    emailFrom: env.EMAIL_FROM || "GatherGate <noreply@localhost>",
    cronIntervalMinutes: parseIntSafe(env.CRON_INTERVAL_MINUTES, 15),
    defaultPurgeDays: Math.max(1, parseIntSafe(env.DEFAULT_PURGE_DAYS, 30)),
    nodeEnv: env.NODE_ENV || "development",
  };

  if (storageBackend === "s3") {
    const endpoint = env.S3_ENDPOINT?.trim() || "";
    const bucket = env.S3_BUCKET?.trim() || "";
    const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() || "";
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() || "";
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY");
    }
    config.s3 = {
      endpoint: endpoint.replace(/\/+$/, ""),
      region: env.S3_REGION?.trim() || "auto",
      bucket,
      accessKeyId,
      secretAccessKey,
    };
  }

  if (emailBackend === "resend") {
    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) throw new Error("RESEND_API_KEY is required when EMAIL_BACKEND=resend");
    config.resendApiKey = apiKey;
  } else if (emailBackend === "smtp") {
    const host = env.SMTP_HOST?.trim() || "";
    if (!host) throw new Error("SMTP_HOST is required when EMAIL_BACKEND=smtp");
    config.smtp = {
      host,
      port: parseIntSafe(env.SMTP_PORT, 587),
      secure: parseBool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || "",
      pass: env.SMTP_PASS || "",
    };
  }

  return config;
}
