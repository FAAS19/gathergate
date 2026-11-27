---
title: Storage Backends (Local & S3 / R2)
description: Configure encrypted local disk storage or S3-compatible object storage (Cloudflare R2, AWS S3, MinIO, Backblaze B2).
---

GatherGate encrypts **every uploaded file in memory** using a per-upload HKDF-SHA256 key and AES-256-GCM **before** writing bytes to disk or sending them to S3. Your object bucket never sees plaintext client PDFs or ID scans.

## Option 1: Encrypted Local Disk (Default)

No extra configuration is required:

```dotenv
STORAGE_BACKEND=local
DATA_DIR=/data
```

- SQLite metadata lives at `DATA_DIR/gathergate.sqlite` (WAL mode).
- Encrypted file blobs live under `DATA_DIR/blobs/` with file mode `0600`.
- When running Docker, always mount a persistent volume or host bind mount at `/data`.

## Option 2: S3-Compatible Storage (Cloudflare R2, AWS S3, MinIO, B2)

GatherGate signs requests using AWS Signature Version 4 (`aws4fetch`) with bounded timeouts (`60s` PUT/GET, `15s` DELETE) and 3 retries on transient `5xx`/`429` responses.

### Cloudflare R2 Example

```dotenv
STORAGE_BACKEND=s3
S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=gathergate-vault
S3_ACCESS_KEY_ID=<r2-api-access-key>
S3_SECRET_ACCESS_KEY=<r2-api-secret-key>
```

### AWS S3 (Sydney `ap-southeast-2`) Example

```dotenv
STORAGE_BACKEND=s3
S3_ENDPOINT=https://s3.ap-southeast-2.amazonaws.com
S3_REGION=ap-southeast-2
S3_BUCKET=your-firm-gathergate-vault
S3_ACCESS_KEY_ID=<iam-access-key-id>
S3_SECRET_ACCESS_KEY=<iam-secret-access-key>
```

### Minimum IAM / Bucket Policy

Scope the credentials strictly to the target bucket with only three object actions:

- `s3:PutObject`
- `s3:GetObject`
- `s3:DeleteObject`

Disable public bucket access. GatherGate never generates public bucket URLs; operators stream decrypted files exclusively through authenticated `/api/uploads/:id/download` and `/api/requests/:id/export.zip` routes.

### Failure & Atomicity Guarantees

- **Startup fail-closed**: If `STORAGE_BACKEND=s3` is set with any missing `S3_*` variable, GatherGate refuses to boot rather than silently falling back to local disk.
- **Atomic multi-file uploads**: All files in a multi-file upload are encrypted and written to storage before SQLite rows commit; if any write fails, uploaded blobs are cleaned up automatically.
- **Automated purging**: When `purge_at` passes, the background purge sweep issues SigV4 `DELETE` calls to shred expired objects from your bucket.
