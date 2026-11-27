import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryEmailAdapter } from "../src/adapters/email.js";
import { createStorageAdapter } from "../src/adapters/storage.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { getSchemaVersion, LATEST_SCHEMA_VERSION, openDatabase } from "../src/db/client.js";
import { hashPassword } from "../src/security/auth.js";
import { encryptBuffer, encryptField, sha256Hex } from "../src/security/crypto.js";

const LEGACY_V01_SCHEMA = `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'self_hosted',
  max_active_requests INTEGER NOT NULL DEFAULT 0,
  max_storage_bytes INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_encrypted TEXT NOT NULL,
  require_otp INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  reminder_interval_days INTEGER NOT NULL DEFAULT 3,
  max_reminders INTEGER NOT NULL DEFAULT 4,
  reminders_sent INTEGER NOT NULL DEFAULT 0,
  reminders_paused INTEGER NOT NULL DEFAULT 0,
  next_reminder_at TEXT,
  purge_after_days INTEGER NOT NULL DEFAULT 30,
  purge_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE request_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT 'General',
  label TEXT NOT NULL,
  help_text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  validator TEXT NOT NULL DEFAULT 'none',
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  value_encrypted TEXT,
  review_note TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  request_item_id TEXT NOT NULL REFERENCES request_items(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  detected_mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  enc_iv TEXT NOT NULL,
  enc_tag TEXT NOT NULL,
  enc_salt TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT
);

CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE client_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE outbox_emails (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

test("Versioned migrations upgrade legacy v0.1.0 SQLite DB cleanly and fail closed on newer schemas", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-migrate-"));
  const dbPath = path.join(tmpDir, "gathergate.sqlite");
  const masterKeyHex = crypto.randomBytes(32).toString("hex");
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    DB_PATH: dbPath,
    MASTER_KEY: masterKeyHex,
    STORAGE_BACKEND: "local",
    EMAIL_BACKEND: "console",
  });
  const storage = createStorageAdapter(config);
  const rawSessionToken = "legacy-session-token-123";
  const now = "2026-11-01T00:00:00.000Z";
  const future = "2027-01-01T00:00:00.000Z";
  const pdfPayload = Buffer.from("%PDF-1.4\n% LEGACY_BLOB\n%%EOF\n");
  const storageKey = "ws_legacy/req_legacy/itm_legacy/legacy.pdf.enc";

  try {
    // 1. Seed a genuine pre-migration v0.1.0 database without schema_migrations or newer columns.
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(LEGACY_V01_SCHEMA);
    legacyDb
      .prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
      .run("ws_legacy", "Legacy Practice", "legacy-practice", now);
    legacyDb
      .prepare("INSERT INTO users (id, workspace_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("usr_legacy", "ws_legacy", "ops@legacy.test", hashPassword("legacy-pass-123"), now);
    legacyDb
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("ses_legacy", "usr_legacy", sha256Hex(rawSessionToken), future, now);

    const magicToken = "legacy-magic-token";
    legacyDb
      .prepare(
        `INSERT INTO requests (
           id, workspace_id, title, client_name, client_email, token_hash, token_encrypted, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "req_legacy",
        "ws_legacy",
        "Legacy Pack",
        "Legacy Client",
        "client@legacy.test",
        sha256Hex(magicToken),
        encryptField(config.masterKey, magicToken, "req_legacy"),
        now
      );
    legacyDb
      .prepare(
        `INSERT INTO request_items (
           id, request_id, position, section, label, kind, required, validator, config_json, status, updated_at
         ) VALUES (?, ?, 0, 'Docs', 'Statement', 'file', 1, 'none', '{}', 'submitted', ?)`
      )
      .run("itm_legacy", "req_legacy", now);

    const { ciphertext, meta } = encryptBuffer(config.masterKey, pdfPayload, storageKey);
    await storage.put(storageKey, ciphertext);
    legacyDb
      .prepare(
        `INSERT INTO uploads (
           id, request_item_id, original_name, canonical_name, detected_mime, size_bytes,
           storage_key, enc_iv, enc_tag, enc_salt, sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "upl_legacy",
        "itm_legacy",
        "statement.pdf",
        "legacy-client_statement_01.pdf",
        "application/pdf",
        meta.sizeBytes,
        storageKey,
        meta.ivHex,
        meta.tagHex,
        meta.saltHex,
        meta.sha256Hex,
        now
      );
    legacyDb.close();

    // 2. Reopen via openDatabase -> runs all migrations cleanly and preserves legacy data.
    const db = openDatabase(dbPath);
    assert.equal(getSchemaVersion(db), LATEST_SCHEMA_VERSION);
    const uvRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(uvRow.user_version, LATEST_SCHEMA_VERSION);

    const uploadRow = db.prepare("SELECT enc_version FROM uploads WHERE id = ?").get("upl_legacy") as {
      enc_version: string;
    };
    assert.equal(uploadRow.enc_version, "v1");

    const v5Tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('api_keys', 'webhook_deliveries')")
      .all() as Array<{ name: string }>;
    assert.equal(v5Tables.length, 2);
    const reqCols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
    assert.ok(reqCols.some((c) => c.name === "overdue_notified_at"));

    const { app } = createApp({
      config,
      db,
      storage,
      email: new MemoryEmailAdapter(),
    });
    const cookie = `gg_session=${rawSessionToken}`;

    for (const url of [
      "/api/requests",
      "/api/clients",
      "/api/settings",
      "/api/api-keys",
      "/api/settings/webhook/deliveries",
    ]) {
      const res = await app.request(url, { headers: { cookie } });
      assert.equal(res.status, 200, `Expected 200 on ${url} after upgrade`);
    }

    const downloadRes = await app.request("/api/uploads/upl_legacy/download", { headers: { cookie } });
    assert.equal(downloadRes.status, 200);
    const downloaded = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepEqual(downloaded, pdfPayload);
    db.close();

    // 3. Reopen again to confirm idempotency.
    const db2 = openDatabase(dbPath);
    assert.equal(getSchemaVersion(db2), LATEST_SCHEMA_VERSION);

    // 4. Newer schema version must fail closed rather than silently corrupt data.
    db2
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(999, "future_schema", now);
    db2.close();

    assert.throws(() => openDatabase(dbPath), /newer than supported version/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
