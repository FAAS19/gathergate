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
- **AES-256-GCM Encryption at Rest & Auto-Purge**: Per-record HKDF keys derived from `MASTER_KEY` encrypt every file and field; completed packs auto-shred after your retention window (default 30 days).
- **Local Email Outbox & Seeded Sample Packs**: Fresh installs can boot with 3 interactive Australian sample checklists and a built-in Local Email Outbox to test invites, 6-digit OTP codes, revision alerts, and scheduled reminders before connecting SMTP or Resend.
- **Deterministic ZIP Export & Signed n8n Webhooks**: Download a cleanly renamed `.zip` (`{client}_{item}_{seq}.{ext}` + `summary.json`) or receive an HMAC-SHA256 `request.completed` webhook straight into n8n or `tensorforge-blueprints`.

---

## 60-Second Self-Hosted Quickstart (Docker)

```bash
cp .env.example .env
# Generate a 32-byte hex MASTER_KEY and add it to .env:
node -e "console.log('MASTER_KEY=' + require('node:crypto').randomBytes(32).toString('hex'))" >> .env

docker compose up -d --build
```

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

## License & Contact

MIT License. See [LICENSE](LICENSE).

Built by **[TensorForge (`tensorforge.dev`)](https://tensorforge.dev)** · [`contact@tensorforge.dev`](mailto:contact@tensorforge.dev?subject=GatherGate%20Enquiry)
