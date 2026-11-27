---
title: Backups & Upgrading
description: Safely back up SQLite WAL databases, protect MASTER_KEY, and upgrade GatherGate without downtime or data loss.
---

GatherGate keeps all state in two places: your **encryption key** (`MASTER_KEY`) and your **data directory** (`DATA_DIR` + optional S3 bucket).

## Backing Up Safely

### 1. Protect `MASTER_KEY` Separately

Without `MASTER_KEY`, encrypted blobs and encrypted SQLite fields (client tax numbers, notes, email credentials, and webhook secrets) cannot be decrypted. Store `MASTER_KEY` in a password manager or secret vault **separate** from your database backups.

### 2. Back Up SQLite WAL Cleanly

Because GatherGate runs SQLite in WAL mode (`gathergate.sqlite`, `-wal`, `-shm`), avoid copying the `.sqlite` file directly while writes are active. Use SQLite's online backup API (`VACUUM INTO` or `.backup`) or pause the container briefly:

```bash
# Consistent online snapshot via Node.js (no downtime)
node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/gathergate.sqlite", { readOnly: true });
  db.exec("VACUUM INTO '\''/backups/gathergate-" + new Date().toISOString().slice(0,10) + ".sqlite'\''");
  db.close();
'
```

If using `STORAGE_BACKEND=local`, also back up `DATA_DIR/blobs/`. If using `STORAGE_BACKEND=s3`, enable bucket versioning or lifecycle backups on your S3/R2 bucket.

## Upgrading GatherGate

SQLite migrations in GatherGate are **append-only, versioned, and idempotent** (`schema_migrations` + `PRAGMA user_version`). On startup, GatherGate applies any pending migrations automatically inside transactions and fails closed if a database is newer than the binary version.

### Docker Upgrade

```bash
# 1. Take a snapshot backup first
docker pull ghcr.io/faas19/gathergate:latest
docker stop gathergate && docker rm gathergate
docker run -d \
  --name gathergate \
  -p 127.0.0.1:3080:3080 \
  -v gathergate_data:/data \
  --env-file .env \
  ghcr.io/faas19/gathergate:latest
```

### `npx` Upgrade

```bash
npx gathergate@latest
```

### Verify After Upgrade

```bash
curl http://127.0.0.1:3080/healthz
```

Confirm logs show no migration errors and sign in to verify existing requests remain accessible.
