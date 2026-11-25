# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues or discussions.

Email security reports directly to **[contact@tensorforge.dev](mailto:contact@tensorforge.dev?subject=GatherGate%20Security%20Report)** with:
- A description of the issue and affected endpoint, file, or component.
- Steps to reproduce or a minimal proof of concept.
- Any suggested mitigation.

We acknowledge reports within 48 hours and coordinate a fix and release before public disclosure.

---

## Threat Model & Security Boundaries

### What GatherGate Protects Against
- **Data at rest:** Uploaded documents and sensitive text fields (such as TFN and Medicare numbers) are encrypted with **AES-256-GCM** using per-record HKDF-SHA256 keys derived from `MASTER_KEY` and bound via authenticated additional data (AAD). Tampered ciphertext fails decryption.
- **Spoofed file uploads:** Every upload is checked by magic-byte signature (`PDF`, `PNG`, `JPEG`, `WebP`, `DOCX`, `XLSX`, `CSV`, `TXT`), not just file extension or `Content-Type`. SVG logos are rejected to prevent embedded script execution.
- **Unsafe inline previews:** Decrypted previews stream with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`. Local Outbox HTML previews render inside empty-sandbox iframes (`sandbox=""`).
- **Sensitive field over-exposure:** Sensitive validators (`au_tfn_mod11`, `au_medicare_mod10`, `uk_nino`, `us_ssn`) stay masked in API responses, operator lists, and completion webhooks unless an authenticated operator triggers an audited reveal.
- **Cross-tenant data access:** All operator endpoints scope queries by the authenticated user's `workspace_id`.
- **Magic-link leakage:** Responses send `Referrer-Policy: no-referrer`. Sensitive checklists can require a 6-digit email OTP with attempt limits and expiry.
- **Retention hygiene:** Completed packs schedule automatic encrypted blob deletion and field erasure (`purge_at`).

### What GatherGate Does Not Protect Against
- **Compromised `MASTER_KEY` or host root access:** If an attacker controls the host runtime or reads `MASTER_KEY`, encrypted blobs and SQLite fields can be decrypted. Store `MASTER_KEY` in a secret manager or hardened environment file in production.
- **Forwarded non-OTP magic links:** Requests created with `requireOtp: false` grant access to anyone holding the magic link URL. Enable email OTP on requests containing TFN, Medicare, or identity documents.
- **Malicious PDF/Office viewer bugs on client devices:** GatherGate verifies file signatures and sandboxes inline previews, but does not run antivirus scanning or content disarm and reconstruction (CDR).

---

## No Telemetry

GatherGate collects **zero telemetry, analytics, or crash reports**. No requests are sent to TensorForge or any third party unless you explicitly configure an outbound email provider (`SMTP` / `Resend`), S3 storage endpoint, or completion webhook URL.
