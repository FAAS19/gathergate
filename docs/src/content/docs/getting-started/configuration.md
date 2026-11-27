---
title: Configuration (.env) Reference
description: Every environment variable supported by GatherGate, with defaults and production rules.
---

GatherGate reads configuration from environment variables (or `.env` via `docker compose`). Copy `.env.example` from the repository root to get started.

## Core Server & Security

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `127.0.0.1` | Bind address. Keep `127.0.0.1` on hosts and let your reverse proxy terminate TLS. In Docker, `docker-compose.yml` sets `0.0.0.0` inside the container while publishing only `127.0.0.1:3080`. |
| `PORT` | `3080` | Listening HTTP port. |
| `BASE_URL` | `http://localhost:3080` | Public external origin used in magic links, emails, and webhook `export_url` values. Must be `https://...` in production so cookies receive the `Secure` attribute. |
| `DATA_DIR` | `./data` | Directory holding `gathergate.sqlite` (WAL), encrypted `blobs/` (when `STORAGE_BACKEND=local`), and auto-generated `.master.key` fallback. |
| `MASTER_KEY` | *(auto-generated)* | 64-character hex string (32 bytes) used for HKDF-SHA256 + AES-256-GCM encryption. Generate with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. |
| `TRUST_PROXY` | `false` | Set `true` **only** behind a trusted TLS reverse proxy so per-IP rate limiting reads forwarded client IPs instead of `127.0.0.1`. |
| `NODE_ENV` | `development` | Set `production` for hardened production runs. |

## Retention & Background Jobs

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CRON_INTERVAL_MINUTES` | `15` | Cadence for automated reminder chases and expired/completed blob purges. Set `0` to disable the in-process timer. |
| `DEFAULT_PURGE_DAYS` | `30` | Days after request completion before encrypted blobs and sensitive fields are purged. Packs using sensitive national ID validators (`au_tfn_mod11`, `au_medicare_mod10`, `uk_nino`, `us_ssn`) automatically default to `14` days. |

## Storage Backend

| Variable | Default | Description |
| :--- | :--- | :--- |
| `STORAGE_BACKEND` | `local` | `local` (encrypted files in `DATA_DIR/blobs`) or `s3` (S3, Cloudflare R2, MinIO, Backblaze B2 via SigV4). |
| `S3_ENDPOINT` | *(required for `s3`)* | Base endpoint URL without bucket path (e.g. `https://<account>.r2.cloudflarestorage.com`). |
| `S3_REGION` | `auto` | SigV4 signing region (`auto` for R2, `ap-southeast-2` for AWS Sydney, `us-east-1`, etc.). |
| `S3_BUCKET` | *(required for `s3`)* | Target bucket name. |
| `S3_ACCESS_KEY_ID` | *(required for `s3`)* | Bucket access key ID. |
| `S3_SECRET_ACCESS_KEY` | *(required for `s3`)* | Bucket secret access key. |

## Email Delivery (Instance Defaults)

Workspace operators can override email settings in-app under **Settings > Email Delivery** (stored encrypted in SQLite). These variables act as instance defaults in single-tenant mode.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `EMAIL_BACKEND` | `console` | `console` (built-in Local Outbox), `smtp`, or `resend`. |
| `EMAIL_FROM` | `GatherGate <noreply@localhost>` | Default `From` header. |
| `RESEND_API_KEY` | *(required for `resend`)* | Resend API key (scope to `sending_access` for your domain). |
| `SMTP_HOST` | *(required for `smtp`)* | SMTP server hostname. |
| `SMTP_PORT` | `587` | SMTP port (`587` STARTTLS or `465` implicit TLS). |
| `SMTP_SECURE` | `false` | Set `true` for implicit TLS (port `465`), `false` for STARTTLS (`587`). |
| `SMTP_USER` | `""` | SMTP username. |
| `SMTP_PASS` | `""` | SMTP password. |

## Tenancy Controls

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MULTI_TENANT` | `false` | `false` = single-workspace self-hosted mode; `true` = enables self-serve workspace signup and strict public-host SSRF guards on webhooks and workspace SMTP. |
| `FREE_MAX_ACTIVE_REQUESTS` | `5` | Active request cap when a workspace is on plan `free` (`0` = unlimited). |
| `FREE_MAX_STORAGE_BYTES` | `1073741824` | Encrypted blob storage cap in bytes for plan `free` (`1 GiB` default, `0` = unlimited). |
