# GatherGate

**Open-source, self-hosted magic-link client document checklist, deterministic validator, and auto-chaser.**

A lightweight MIT-licensed alternative to Content Snare and FileInvite built on Node.js, Hono, SQLite (WAL), React 19, and official `shadcn/ui` + Tailwind CSS v4. Engineered by **[TensorForge (`tensorforge.dev`)](https://tensorforge.dev)** · Melbourne, Australia.

---

## Why GatherGate Exists

Chasing clients for documents over email breaks down fast: clients forget attachments, abandon password-protected portals, or email sensitive PDFs and Tax File Numbers in plaintext.

GatherGate ships as a single hardened Docker container (zero external database required) with:

- **Daylight-First Operator Console (`shadcn/ui`)**: Collapsible sidebar shell, `Cmd+K` quick jump, clickable KPI strip, sortable/filterable requests table, and optional operator dark mode.
- **Passwordless Client Magic Links + Official 6-Digit Email OTP**: Stepped light portal with drag-and-drop uploads, debounced auto-save, mobile-ready inputs, and pinned revision callouts.
- **Inline Encrypted PDF & Image Preview + Approve / Revise Loop**: Review uploaded PDFs and scans inline inside a decrypted preview sheet, lock verified items with one click, or request revisions with quick feedback notes.
- **Visual Drag-and-Drop Template Builder**: Reorder checklist sections and items visually with live client-portal preview (zero raw JSON editing required).
- **Deterministic Validation Gate (Zero AI Slop)**:
  - Magic-byte file signature checks (`PDF`, `PNG`, `JPEG`, `WebP`, `DOCX`, `XLSX`, `CSV`, `TXT`) block spoofed executables.
  - Built-in Australian statutory checksums: **ATO ABN (mod-89)**, **BSB (6-digit)**, **TFN (mod-11, encrypted & masked with audited reveal)**, **Medicare Card + IRN (mod-10, masked)**, and **`+61` E.164** phone normalisation, plus email and URL validators.
- **AES-256-GCM Encryption at Rest & Auto-Purge**: Per-record HKDF keys (`v1` metadata) derived from `MASTER_KEY` encrypt every file and field; completed packs auto-shred after your retention window (14 days by default for TFN/Medicare packs, 30 days otherwise).
- **Local Email Outbox & Seeded Sample Packs**: Fresh installs can boot with 3 interactive Australian sample checklists and a built-in Local Email Outbox to test invites, 6-digit OTP codes, revision alerts, and scheduled reminders before connecting SMTP or Resend.
- **Deterministic ZIP Export & Signed n8n Webhooks**: Download a cleanly renamed `.zip` (`{client}_{item}_{seq}.{ext}` + `summary.json`) or receive an HMAC-SHA256 `request.completed` webhook straight into n8n or `tensorforge-blueprints`.

---

## 60-Second Self-Hosted Quickstart (Docker)

Boot GatherGate from source in one command (zero `.env` required on first run):

```bash
docker compose up -d --build
```

Or run the published container image directly:

```bash
docker run -d --name gathergate -p 127.0.0.1:3080:3080 -v gathergate_data:/data ghcr.io/faas19/gathergate:latest
```

On first boot with `MASTER_KEY` unset, GatherGate generates a 32-byte key at `DATA_DIR/.master.key` and shows a persistent reminder banner until you move `MASTER_KEY` into an environment variable (see `.env.example`) and restart.

Open `http://127.0.0.1:3080` to complete first-boot workspace setup. Four starter packs are seeded automatically:

1. **Agency / Web Project Client Onboarding**
2. **AU Individual Tax Return (EOFY Pack)**
3. **AU Company / BAS Bookkeeping Pack**
4. **AU Allied Health Clinic New Patient Intake**

---

## Local Development & Verification

Requires Node.js >= 22.13 (Node 24+ recommended for built-in `node:crypto.argon2Sync` and `node:sqlite`):

```bash
npm install
npm --prefix client install
npm run typecheck
npm run build
npm test
npm start
```

For hot-reloading UI work during development, run `npm run dev` (backend on `:3080`) and `npm run dev:client` (Vite dev server on `:5173` proxying `/api`).

---

## Storage, Email & Hosted Multi-Tenant Mode

- **Storage (`STORAGE_BACKEND`)**: `local` (encrypted blobs in `DATA_DIR/blobs`, default) or `s3` (Cloudflare R2, AWS S3, MinIO, Backblaze B2 via SigV4).
- **Email (`EMAIL_BACKEND`)**: `console` (routes to Local Email Outbox + stdout), `smtp` (Nodemailer), or `resend` (Resend HTTP API).
- **Tenancy (`MULTI_TENANT`)**: `false` for single-workspace self-hosting (unlimited requests/storage), or `true` for hosted multi-tenant mode with configurable free-tier caps (`FREE_MAX_ACTIVE_REQUESTS`, `FREE_MAX_STORAGE_BYTES`).

---

## Backup & Restore

GatherGate stores all structured state in `DATA_DIR/gathergate.sqlite` and all encrypted uploads in `DATA_DIR/blobs/`. Decryption depends on `MASTER_KEY` (stored outside backups in your secret manager or `.env`).

### Backup

Stop the container (or run SQLite's online `.backup` command) so WAL frames are checkpointed before copying:

```bash
docker compose stop gathergate
docker run --rm -v gathergate_gathergate_data:/data -v "$PWD:/backup" alpine \
  tar -czf "/backup/gathergate-backup-$(date +%F).tar.gz" -C /data gathergate.sqlite blobs
docker compose start gathergate
```

Store `MASTER_KEY` separately in your password/secret manager so a backup archive alone cannot decrypt client records.

### Restore

Restore the archive into a fresh `/data` volume, supply the matching `MASTER_KEY` in `.env` or `-e MASTER_KEY=...`, then boot and verify a document preview or ZIP export decrypts cleanly:

```bash
docker volume create gathergate_gathergate_data
docker run --rm -v gathergate_gathergate_data:/data -v "$PWD:/backup" alpine \
  tar -xzf /backup/gathergate-backup-YYYY-MM-DD.tar.gz -C /data
docker compose up -d
```

---

## Contributing, Security & Changelog

- **Feature & Bug-Fix Workflow:** See [CONTRIBUTING.md](CONTRIBUTING.md) (trunk-based `main`, verification gate, and Validator Pack guide).
- **Security & Threat Model:** See [SECURITY.md](SECURITY.md) (zero telemetry, AES-256-GCM boundaries, responsible disclosure).
- **Release History:** See [CHANGELOG.md](CHANGELOG.md).

---

## License & Contact

MIT License. See [LICENSE](LICENSE).

Built by **[TensorForge (`tensorforge.dev`)](https://tensorforge.dev)** · [`contact@tensorforge.dev`](mailto:contact@tensorforge.dev?subject=GatherGate%20Enquiry)
