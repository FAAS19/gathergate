import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StorageBackend = "local" | "s3";
export type EmailBackend = "console" | "smtp" | "resend";

export interface AppConfig {
  port: number;
  host: string;
  baseUrl: string;
  dataDir: string;
  dbPath: string;
  masterKey: Buffer;
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

function resolveMasterKey(env: NodeJS.ProcessEnv, dataDir: string): Buffer {
  const raw = env.MASTER_KEY?.trim();
  if (raw) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error("MASTER_KEY must be a 64-character hex string (32 bytes)");
    }
    return Buffer.from(raw, "hex");
  }
  if (env.NODE_ENV === "production") {
    throw new Error("MASTER_KEY is required when NODE_ENV=production");
  }
  // Persist auto-generated dev key under dataDir so restarts can still decrypt local test blobs.
  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dataDir, ".dev-master.key");
  if (fs.existsSync(keyFile)) {
    const stored = fs.readFileSync(keyFile, "utf8").trim();
    if (/^[0-9a-fA-F]{64}$/.test(stored)) {
      return Buffer.from(stored, "hex");
    }
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString("hex") + "\n", { mode: 0o600 });
  return generated;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR || "./data");
  const dbPath = env.DB_PATH || path.join(dataDir, "gathergate.sqlite");
  const storageBackend = (env.STORAGE_BACKEND || "local") as StorageBackend;
  const emailBackend = (env.EMAIL_BACKEND || "console") as EmailBackend;

  const config: AppConfig = {
    port: parseIntSafe(env.PORT, 3080),
    host: env.HOST || "127.0.0.1",
    baseUrl: (env.BASE_URL || `http://localhost:${parseIntSafe(env.PORT, 3080)}`).replace(/\/+$/, ""),
    dataDir,
    dbPath,
    masterKey: resolveMasterKey(env, dataDir),
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
