<div align="center">

<img alt="GatherGate self-hosted client document intake" src=".github/assets/banner-dark.webp" width="100%" />

<br />

Self-hosted, open-source alternative to Content Snare and FileInvite. Collect client documents via passwordless magic links with deterministic validation, AES-256-GCM encryption, and keyboard-first review in one container.

<p>
  <a href="#quickstart"><img src=".github/assets/cta-quickstart.svg" alt="Quickstart in 30s" height="38" /></a>&nbsp;&nbsp;<a href="#product-tour"><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/cta-tour-dark.svg" /><source media="(prefers-color-scheme: light)" srcset=".github/assets/cta-tour-light.svg" /><img src=".github/assets/cta-tour-light.svg" alt="Product Tour" height="38" /></picture></a>&nbsp;&nbsp;<a href="SECURITY.md"><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/cta-security-dark.svg" /><source media="(prefers-color-scheme: light)" srcset=".github/assets/cta-security-light.svg" /><img src=".github/assets/cta-security-light.svg" alt="Security Model" height="38" /></picture></a>
</p>

<p>
  <a href=".github/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-passing-2ea043?style=flat&logo=githubactions&logoColor=white" alt="CI passing" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/release-v1.0.0-007ec6?style=flat" alt="Release v1.0.0" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-dfb317?style=flat" alt="MIT Licence" /></a>
  <a href=".github/workflows/ci.yml"><img src="https://img.shields.io/badge/tests-66%20passing-44cc11?style=flat" alt="66 tests passing" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node >= 22.13" /></a>
  <a href="Dockerfile"><img src="https://img.shields.io/badge/docker-amd64%20%7C%20arm64-2496ED?style=flat&logo=docker&logoColor=white" alt="Docker amd64 and arm64" /></a>
  <a href=".github/workflows/ci.yml"><img src="https://img.shields.io/badge/WCAG%202.2-AA-7c3aed?style=flat" alt="WCAG 2.2 AA" /></a>
</p>

<p>
  <a href="#why-gathergate">Why GatherGate</a> &middot;
  <a href="#validator-packs">Validator Packs</a> &middot;
  <a href="#compare">Compare</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

</div>

<p align="center">
  <img src=".github/assets/demo-workflow.webp" width="100%" alt="GatherGate workflow: passwordless client ABN mod-89 validation, encrypted tax invoice upload, and dark-mode operator review" />
</p>

## Why GatherGate

- **Stop chasing scattered email attachments:** Replace long reply threads and broken shared-drive links with one passwordless magic-link checklist per client.
- **Catch bad tax and bank IDs at submission:** Deterministic checksum validators reject mistyped ABNs, TFNs, UTRs, EINs, IBANs, and routing numbers before your team discovers them weeks later.
- **Keep sensitive documents off third-party SaaS:** Avoid per-seat SaaS pricing and external vendor custody of tax, KYC, and identity files by running everything in one container on your own infrastructure.

## Quickstart

Boot from source with Docker Compose:

```bash
docker compose up -d --build
```

Or pull the multi-arch (`linux/amd64`, `linux/arm64`) image with zero `.env` setup on first boot:

```bash
docker run -d --name gathergate -p 127.0.0.1:3080:3080 -v gathergate_data:/data ghcr.io/faas19/gathergate:latest
```

When `MASTER_KEY` is unset, GatherGate generates a 32-byte key at `DATA_DIR/.master.key` and displays a banner until you move `MASTER_KEY` into your environment (see [`.env.example`](.env.example)). Open `http://127.0.0.1:3080` to initialise your workspace.

## Product Tour

**Operator Console** (`J`/`K` row selection and `Enter` to open requests from the console, `Space`/`A`/`R` review triage inside `ReviewSheet`, unified status filters, and automated reminder counters; toggles between dark zinc and Daylight themes and adapts automatically to your GitHub theme):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/dashboard-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="site/public/screenshots/operator-dashboard.png" />
  <img alt="GatherGate operator dashboard showing active intake packs, verification counts, and follow-up status" src="site/public/screenshots/operator-dashboard.png" width="100%" />
</picture>

**Inline Decrypted Review (`ReviewSheet`)** (inspect decrypted PDFs, tax invoice scans, and CSV/text files inside a sandboxed drawer with `Space`, approve and advance with `A`, or request revisions with `R`):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/review-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="site/public/screenshots/operator-review.png" />
  <img alt="GatherGate inline review drawer displaying a decrypted client tax invoice alongside approve and revision controls" src="site/public/screenshots/operator-review.png" width="100%" />
</picture>

**Passwordless Client Portal** (white-labelled with your practice colours and logo, automatic debounced saves, optional 6-digit email OTP, N/A notes, and mobile camera capture):

![GatherGate white-labelled client portal showing section navigation, live ABN verification, and auto-saved responses](site/public/screenshots/client-portal-desktop.png)

## Architecture & Capabilities

Built on Node.js 24 (`node:sqlite` WAL + `node:crypto`), Hono (5 production dependencies), React 19, `shadcn/ui`, and Tailwind CSS v4 with zero telemetry:

- **Per-record AES-256-GCM vault**: Every uploaded file and sensitive text field derives a unique HKDF-SHA256 subkey from `MASTER_KEY` bound with authenticated additional data (`enc_version = "v1"`).
- **Magic-byte inspection**: Verifies real file signatures (`PDF`, `PNG`, `JPEG`, `WebP`, `DOCX`, `XLSX`, `CSV`, `TXT`) before storage and rejects executables, HTML, SVG uploads, and arbitrary ZIPs.
- **Sandboxed inline previews**: Decrypted previews stream with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- **Canonical ZIP export & signed webhooks**: Export consistently named packs (`{client}_{item}_{seq}.{ext}` + `summary.json`) or receive HMAC-SHA256 `request.completed` webhooks into n8n or downstream pipelines.
- **Scheduled retention auto-purge**: Automatically deletes completed encrypted blobs and erases stored field values after your retention window (14 days default for TFN, Medicare, UK NINO, and US SSN packs, 30 days otherwise).

## Validator Packs

Validators live in `src/validators/packs/` and execute deterministically before submissions enter your review queue (unknown validator keys fail closed):

| Pack | Module | Deterministic Rules |
| :--- | :--- | :--- |
| **Generic** | [`src/validators/packs/generic.ts`](src/validators/packs/generic.ts) | `email`, `url`, `phone_e164` (international E.164), `iban` (ISO 13616 mod-97) |
| **Australia** | [`src/validators/packs/au.ts`](src/validators/packs/au.ts) | `au_abn_mod89`, `au_bsb`, `au_tfn_mod11` (masked + audited reveal), `au_medicare_mod10` (masked), `au_phone_e164` |
| **United Kingdom** | [`src/validators/packs/uk.ts`](src/validators/packs/uk.ts) | `uk_utr_mod11` (HMRC 10-digit mod-11), `uk_nino` (masked), `uk_sort_code` (6-digit) |
| **United States** | [`src/validators/packs/us.ts`](src/validators/packs/us.ts) | `us_ein` (IRS prefix + 9-digit), `us_routing_aba` (ABA mod-10), `us_ssn` (SSA rules, masked) |
| **European Union** | [`src/validators/packs/eu.ts`](src/validators/packs/eu.ts) | `eu_vat` (27-country format + BE/DE/FR checksums) |

Adding more regional packs (NZ, CA, SG, JP) requires one module implementing `ValidatorPack`; see [CONTRIBUTING.md](CONTRIBUTING.md).

<a id="compare"></a>

## How GatherGate Compares

| Capability | GatherGate (Self-Hosted) | Content Snare | FileInvite |
| :--- | :--- | :--- | :--- |
| **Pricing** | Free & MIT open source (self-hosted) | Paid monthly request & team tiers | Paid per-seat & enterprise tiers |
| **Data residency & encryption** | Your host or S3 bucket, per-record AES-256-GCM with auto-purge | Vendor-managed SaaS infrastructure | Vendor-managed SaaS infrastructure |
| **Deterministic checksums & magic-bytes** | Built-in mod-89/11/10/97 packs plus binary signature inspection | Basic field formatting & extension rules | Basic field validation & accepted file lists |
| **Automated follow-ups & ZIP export** | Scheduled chasers, canonical ZIP & signed HMAC webhooks | Scheduled reminders & PDF/ZIP exports | Scheduled reminders & portal downloads |
| **Source & lock-in** | Full source on GitHub, portable SQLite & encrypted blobs | Closed-source SaaS | Closed-source SaaS |

## Configuration

<details>
<summary>Storage, Email, Tenancy &amp; Environment Reference</summary>

| Variable | Default | Options / Notes |
| :--- | :--- | :--- |
| `MASTER_KEY` | Auto-generated file | 64-char hex key (32 bytes) for HKDF + AES-256-GCM encryption |
| `STORAGE_BACKEND` | `local` | `local` (`DATA_DIR/blobs`) or `s3` (Cloudflare R2, AWS S3, MinIO, Backblaze B2 via SigV4) |
| `EMAIL_BACKEND` | `console` | `console` (Local Email Outbox + stdout), `smtp` (Nodemailer), or `resend` (Resend HTTP API); also configurable per workspace in `/settings` |
| `MULTI_TENANT` | `false` | `false` for single-workspace unlimited hosting, or `true` with `FREE_MAX_ACTIVE_REQUESTS` and `FREE_MAX_STORAGE_BYTES` |

See [`.env.example`](.env.example) for the complete list of environment variables.

</details>

<details>
<summary>Backup &amp; Restore</summary>

Stop the container so SQLite WAL frames checkpoint cleanly before archiving `gathergate.sqlite` and `blobs/` (keep `MASTER_KEY` in your secret manager, separate from backup archives):

```bash
# Backup
docker compose stop gathergate
docker run --rm -v gathergate_gathergate_data:/data -v "$PWD:/backup" alpine \
  tar -czf "/backup/gathergate-backup-$(date +%F).tar.gz" -C /data gathergate.sqlite blobs
docker compose start gathergate

# Restore
docker volume create gathergate_gathergate_data
docker run --rm -v gathergate_gathergate_data:/data -v "$PWD:/backup" alpine \
  tar -xzf /backup/gathergate-backup-YYYY-MM-DD.tar.gz -C /data
docker compose up -d
```

</details>

<details>
<summary>Local Development &amp; Verification</summary>

Requires Node.js >= 22.13 (Node 24+ recommended for built-in `node:crypto.argon2Sync` and `node:sqlite`):

```bash
npm install
npm --prefix client install
npm run typecheck
npm run build
npm test
npm run test:e2e
```

For hot-reloading UI development, run `npm run dev` (API on `:3080`) and `npm run dev:client` (Vite on `:5173`). To build and test the static showcase site and `VITE_DEMO=1` browser bundle locally, run `npm run build:pages && npm run test:pages`.

</details>

## Security, Contributing & Licence

- **Security & Threat Model**: [SECURITY.md](SECURITY.md) (zero telemetry guarantee and vulnerability reporting)
- **Contributing & Validator Packs**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **Release History**: [CHANGELOG.md](CHANGELOG.md)
- **Licence**: [MIT](LICENSE) · Built by **[TensorForge](https://tensorforge.dev)** ([`contact@tensorforge.dev`](mailto:contact@tensorforge.dev?subject=GatherGate%20Enquiry))
