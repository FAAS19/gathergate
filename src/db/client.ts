import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PRAGMAS_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'self_hosted',
  max_active_requests INTEGER NOT NULL DEFAULT 0,
  max_storage_bytes INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  webhook_secret TEXT,
  email_backend TEXT,
  email_from TEXT,
  email_reply_to TEXT,
  email_config_encrypted TEXT,
  brand_color TEXT,
  logo_mime TEXT,
  logo_b64 TEXT,
  support_email TEXT,
  support_phone TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
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
  is_demo INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  client_subject TEXT,
  welcome_note TEXT,
  last_opened_at TEXT,
  last_manual_reminder_at TEXT,
  overdue_notified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_workspace ON requests(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_reminder ON requests(status, reminders_paused, next_reminder_at);
CREATE INDEX IF NOT EXISTS idx_requests_purge ON requests(purge_at);

CREATE TABLE IF NOT EXISTS request_items (
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
  client_note_encrypted TEXT,
  client_na INTEGER NOT NULL DEFAULT 0,
  review_note TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_items_req ON request_items(request_id, position);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  request_item_id TEXT NOT NULL REFERENCES request_items(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  detected_mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  enc_version TEXT NOT NULL DEFAULT 'v1',
  enc_iv TEXT NOT NULL,
  enc_tag TEXT NOT NULL,
  enc_salt TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_uploads_item ON uploads(request_item_id);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_emails (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT,
  kind TEXT NOT NULL DEFAULT 'general',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_workspace ON outbox_emails(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  target_url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  last_status_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ws ON webhook_deliveries(workspace_id, created_at DESC);
`;

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

function ensureColumn(db: DatabaseSync, table: string, col: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

function ensureColumns(db: DatabaseSync, tableCols: Record<string, Array<[string, string]>>): void {
  for (const [table, columns] of Object.entries(tableCols)) {
    for (const [col, def] of columns) {
      ensureColumn(db, table, col, def);
    }
  }
}

// Append-only versioned migrations; never renumber or alter previously released entries.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_initial_schema",
    up: (db) => {
      db.exec(SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: "002_portal_branding_and_client_notes",
    up: (db) => {
      ensureColumns(db, {
        requests: [
          ["is_demo", "INTEGER NOT NULL DEFAULT 0"],
          ["due_at", "TEXT"],
          ["client_subject", "TEXT"],
          ["welcome_note", "TEXT"],
          ["last_opened_at", "TEXT"],
          ["last_manual_reminder_at", "TEXT"],
        ],
        workspaces: [
          ["brand_color", "TEXT"],
          ["logo_mime", "TEXT"],
          ["logo_b64", "TEXT"],
          ["support_email", "TEXT"],
          ["support_phone", "TEXT"],
        ],
        request_items: [
          ["client_note_encrypted", "TEXT"],
          ["client_na", "INTEGER NOT NULL DEFAULT 0"],
        ],
        outbox_emails: [["html_body", "TEXT"]],
      });
    },
  },
  {
    version: 3,
    name: "003_workspace_email_and_user_profile",
    up: (db) => {
      ensureColumns(db, {
        workspaces: [
          ["email_backend", "TEXT"],
          ["email_from", "TEXT"],
          ["email_reply_to", "TEXT"],
          ["email_config_encrypted", "TEXT"],
        ],
        users: [["display_name", "TEXT"]],
      });
    },
  },
  {
    version: 4,
    name: "004_upload_enc_version",
    up: (db) => {
      ensureColumn(db, "uploads", "enc_version", "TEXT NOT NULL DEFAULT 'v1'");
    },
  },
  {
    version: 5,
    name: "005_api_keys_and_webhook_deliveries",
    up: (db) => {
      ensureColumn(db, "requests", "overdue_notified_at", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          scopes_json TEXT NOT NULL,
          created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          last_used_at TEXT,
          expires_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
          event TEXT NOT NULL,
          target_url TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 6,
          last_status_code INTEGER,
          last_error TEXT,
          next_attempt_at TEXT,
          delivered_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ws ON webhook_deliveries(workspace_id, created_at DESC);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function getSchemaVersion(db: DatabaseSync): number {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!tableExists) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row?.v ?? 0;
}

function applyVersionedMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => Number(r.version)));
  const maxApplied = appliedRows.reduce((max, r) => Math.max(max, Number(r.version)), 0);

  if (maxApplied > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${maxApplied} is newer than supported version ${LATEST_SCHEMA_VERSION}`
    );
  }

  let appliedAny = false;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
      db.exec(`PRAGMA user_version = ${migration.version};`);
      db.exec("COMMIT");
      appliedAny = true;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  if (appliedAny) {
    // Checkpoint schema_migrations + user_version header offset 60 into main file so read-only doctor sees latest version.
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
  }
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(PRAGMAS_SQL);
    applyVersionedMigrations(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
