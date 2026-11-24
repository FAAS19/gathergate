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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR || "./data");
  const dbPath = env.DB_PATH || path.join(dataDir, "gathergate.sqlite");
  const storageBackend = (env.STORAGE_BACKEND || "local") as StorageBackend;
  const emailBackend = (env.EMAIL_BACKEND || "console") as EmailBackend;
  const resolvedKey = resolveMasterKey(env, dataDir);

  const config: AppConfig = {
    port: parseIntSafe(env.PORT, 3080),
    host: env.HOST || "127.0.0.1",
    baseUrl: (env.BASE_URL || `http://localhost:${parseIntSafe(env.PORT, 3080)}`).replace(/\/+$/, ""),
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
