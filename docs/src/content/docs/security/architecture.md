---
title: Security & Threat Model
description: How GatherGate encrypts data at rest, sniffs uploaded files, sandboxes previews, and enforces tenant isolation.
---

GatherGate is designed for practices handling regulated identity, tax, financial, and clinical records on their own infrastructure.

## Protections Built In

### 1. Per-Record Encryption at Rest
- Uploaded files, sensitive text fields, client notes, workspace email credentials, and webhook signing secrets are encrypted with **AES-256-GCM**.
- Every record derives its own unique 256-bit key via **HKDF-SHA256** from `MASTER_KEY` and binds the ciphertext to its record/workspace ID using **authenticated additional data (AAD)**.
- Tampering with ciphertext or swapping encrypted values across rows fails authentication immediately.
- Uploaded blobs record `enc_version = "v1"` in SQLite for future key-rotation workflows.

### 2. Fail-Closed Magic-Byte File Sniffing
Every upload is inspected by binary signature (`src/security/magic-bytes.ts`), never just file extension or `Content-Type`:

- **Allowed**: `PDF`, `PNG`, `JPEG`, `WebP`, `DOCX`, `XLSX`, `CSV`, `TXT`.
- **Blocked**: Spoofed executables, HTML/JavaScript masquerading as images, formula-injection CSV cells, and SVG workspace logos (preventing stored XSS via embedded `<script>`).

### 3. Sandboxed Previews & Strict Headers
- Decrypted operator document previews stream with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`.
- Local Outbox HTML previews render inside empty-sandbox iframes (`sandbox=""`).
- Magic-link portal responses send `Referrer-Policy: no-referrer` so client tokens never leak to external links.

### 4. Authentication, OTP & Rate Limiting
- Operator passwords use native Node.js **Argon2id** (`19 MiB`, 2 passes; `scrypt` fallback on Node 22).
- Optional 6-digit Email OTP enforces expiry, single-use invalidation, and **immediate 5th-attempt lockout** (`429`).
- Fixed-window per-IP and per-token rate limits protect login, OTP, and upload endpoints (`429` + `Retry-After`).
- Every operator query and route is scoped by `auth.workspace.id` with cross-tenant IDOR regression tests.

### 5. Automated Retention & Purging
Completed packs schedule automatic cryptographic blob deletion and sensitive field erasure (`purge_at`), defaulting to **14 days** when sensitive national ID validators are present and **30 days** otherwise.

## Out-of-Scope Threat Boundaries

- **Compromised host or `MASTER_KEY`**: An attacker with root shell access or read access to `MASTER_KEY` can decrypt stored records. Keep `MASTER_KEY` in a secret manager or hardened environment config.
- **Forwarded non-OTP magic links**: Anyone holding an open magic-link URL can view and submit items until locked or expired. Enable Email OTP on requests collecting tax, identity, or medical records.
- **Client-side PDF/Office viewer bugs**: GatherGate verifies file signatures and sandboxes inline previews, but does not run antivirus scanning or content disarm and reconstruction (CDR).

## Vulnerability Disclosure

Do **not** open public GitHub issues for security bugs. Use GitHub Private Vulnerability Reporting on [`FAAS19/gathergate`](https://github.com/FAAS19/gathergate/security) or email **`contact@tensorforge.dev`**.
