import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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
  kind TEXT NOT NULL DEFAULT 'general',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_workspace ON outbox_emails(workspace_id, created_at DESC);
`;

// Additive, idempotent column migrations. Append only; never rename or drop.
const COLUMN_MIGRATIONS: Record<string, Array<[string, string]>> = {
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
    ["email_backend", "TEXT"],
    ["email_from", "TEXT"],
    ["email_reply_to", "TEXT"],
    ["email_config_encrypted", "TEXT"],
  ],
  users: [["display_name", "TEXT"]],
  request_items: [
    ["client_note_encrypted", "TEXT"],
    ["client_na", "INTEGER NOT NULL DEFAULT 0"],
  ],
  outbox_emails: [["html_body", "TEXT"]],
};

function applyAdditiveMigrations(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    for (const [col, def] of columns) {
      if (!existing.has(col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    }
  }
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  applyAdditiveMigrations(db);
  return db;
}
