# Changelog

All notable changes to GatherGate are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-25

### Added
- **Launch Assets & Release Verification (`e2e/`):** Animated workflow WebP (`.github/assets/demo-workflow.webp`), dark repository banner (`.github/assets/banner-dark.webp`), `2160x1080` social preview / OpenGraph card (`site/public/social-preview.png`), timed `<60s` 1-command Docker quickstart check (`e2e/verify-docker-quickstart.mjs`), and README asset/version verification script (`e2e/verify-readme.mjs`).
- **Global Validator Packs & Starter Templates:** Added United Kingdom (`uk_utr_mod11`, `uk_nino`, `uk_sort_code`), United States (`us_ein`, `us_routing_aba`, `us_ssn`), and European Union (`eu_vat`) deterministic validator packs alongside Legal/KYC and Mortgage/Loan starter templates.
- **Dashboard Keyboard Triage & Filter Strip:** Added `J`/`K`/`Enter` keyboard row selection and opening on the operator dashboard, a unified status filter strip, and macOS `⌘K` command-palette shortcut labelling.
- **Landing-Page Validator Playground & Typography (`site/`):** Added an interactive deterministic validator playground, Plus Jakarta Sans display typography, and neutral zinc dark mode on the static showcase site.
- **OSS Community & Container Defaults:** Added `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml`, and `TZ=${TZ:-UTC}` default in `docker-compose.yml`.
- **GitHub Pages Showcase & Interactive Browser Demo (`site/`, `VITE_DEMO=1`):** Daylight-first static showcase site with product walkthrough tabs, pluggable Validator Pack overview, 1-command Docker quickstart, comparison table, and Managed Cloud enquiry CTA; backed by a zero-server `HashRouter` interactive demo (`site/dist/demo/`) and automated `.github/workflows/pages.yml` deployment.
- **Launch Assets & Subpath Verification:** Automated viewport screenshot capture (`e2e/capture-showcase.mjs`), strict `/gathergate/` subpath + interactive demo Playwright E2E & WCAG 2.2 AA suite (`e2e/pages.spec.ts`), and global launch-ready `README.md`.
- Versioned SQLite migration runner (`schema_migrations` + `PRAGMA user_version`) supporting clean upgrades from legacy v0.1.0 databases and fail-closed downgrade protection.
- Versioned blob encryption metadata (`enc_version = "v1"` on `uploads` + HKDF derivation check) for future `MASTER_KEY` rotation.
- Zero-config `MASTER_KEY` auto-generation (`DATA_DIR/.master.key`) on first boot with a persistent operator reminder banner (`AppShell` + `/settings?section=instance`) and optional `.env` loading in `docker-compose.yml`.
- Dedicated migration upgrade suite (`tests/migrations.test.ts`) and negative security suite (`tests/security.test.ts`) covering cross-tenant IDOR, OTP lockouts/expiry/replay, rate limits, spoofed uploads, expired/purged tokens, and HMAC webhooks.
- Trunk-based contributor workflow (`CONTRIBUTING.md`), security policy and threat model (`SECURITY.md`), GitHub Actions CI (`ci.yml`), SemVer multi-arch GHCR release workflow (`release.yml`), issue/PR templates, and Dependabot configuration.
- In-app **Email Delivery** configuration (`PUT /api/settings/email`, `POST /api/settings/email/test`) supporting Local Outbox, SMTP (Gmail, Outlook/M365, Fastmail, Amazon SES, Custom presets), and Resend with AES-256-GCM encrypted credentials and non-echoed secrets.
- **Account & Security** settings (`PUT /api/account`, `PUT /api/account/password`) for workspace name, display name, sign-in email, and password updates with automatic revocation of other sessions.
- Custom popover colour picker (`react-colorful`) with synced HEX, `R`/`G`/`B` numeric inputs, live `rgb(...)` readout, and 10 WCAG-AA preset swatches.
- Standalone `/outbox` route (`OutboxPage`) and backend `tests/settings.test.ts` coverage.
- **Clients Directory (`/clients`, `GET /api/clients`):** Aggregated client list with active/awaiting-review/completed pack counts, slide-over checklist history drawer, and 1-click pre-filled repeat request creation (`/requests/new?clientName=...&clientEmail=...`).
- Live `Awaiting review` badge on the `Requests` sidebar link (`readiness.awaitingReviewCount`).

### Changed
- Neutral zinc dark-mode tokens (`#09090b` canvas, `#121215` cards, `#0e0e11` sidebar) reserving pine/emerald strictly for primary actions and focus rings.
- Redesigned `/settings` with vertical left sub-navigation (`?section=branding|email|account|webhooks|instance`), upgraded `AppShell` with a 1-click header theme toggle, compact sidebar collapse toggle inside `SidebarHeader` (`[` keyboard shortcut), clean separation between workspace branding and operator identity in the footer menu, conditional `Local Outbox` sidebar visibility when using console delivery, and removed redundant Vault telemetry from the sidebar footer.
- Migrated app and portal icons to `@phosphor-icons/react` and removed unused `next-themes` and `@fontsource-variable/geist` client packages.

### Fixed
- Smart initials extraction (`getInitials` / `operatorDisplayName`) strips `&`, punctuation, and business stop-words so names like `Spine & Strength Chiropractic` render `SS` instead of `S&`, while operator profiles derive clean names instead of displaying raw email prefixes.
- Linked Outbox preview tabs to `TabsContent` ARIA panels and included `/outbox` and `/clients` in Light/Dark WCAG 2.2 AA `axe-core` E2E verification.

### Security
- In-memory fixed-window per-IP and per-token rate limiting (`429` + `Retry-After`) on `/api/login`, `/api/client/:token/otp/send`, `/api/client/:token/otp/verify`, and file upload endpoints, with opt-in `TRUST_PROXY` header parsing.
- Immediate 5th-attempt OTP lockout (`429`), strict expired (`410`) and purged (`200` empty items / `403` writes) portal guards, malformed multipart error handling, and unauthenticated file-delete enumeration prevention.
- Default 14-day auto-purge retention window whenever a request or starter template includes sensitive national IDs (`au_tfn_mod11`, `au_medicare_mod10`, `uk_nino`, `us_ssn`).

## [0.1.0] - 2026-11-22

### Added
- **Core Vault & Auth:** Self-hosted Node.js + Hono JSON API, SQLite WAL (`node:sqlite`), Argon2id/scrypt operator auth, per-record HKDF AES-256-GCM encryption at rest, magic-byte file verification, streaming decrypted ZIP export, HMAC-SHA256 completion webhooks, Local Email Outbox, and single-container Docker build.
- **Validator Packs (Milestone 1):** Pluggable validator registry with generic (`email`, `url`, `phone_e164`, `iban`) and Australian statutory (`au_abn_mod89`, `au_bsb`, `au_tfn_mod11`, `au_medicare_mod10`, `au_phone_e164`) packs; unknown validators fail closed.
- **White-Label Client Portal (Milestone 1):** Split-screen `/setup` with live portal preview, workspace branding (logo, WCAG-checked accent colour, support email/phone), branded HTML + plain-text emails, XHR upload progress bar, file delete/replace before approval, encrypted client notes and "Not applicable" escape hatch, mobile camera upload, and jump sheet.
- **High-Velocity Operator Console (Milestone 2):** Continuous document review sheet (`Prev`/`Next`, 75%-200% zoom, `Approve & next`, `Request revision`), keyboard-first triage (`J`/`K`/`Space`/`A`/`R`/`Esc`/`?`), optimistic updates with functional-updater rollback, manual `"Send reminder now"` with 15-minute cooldown, inline due-date editing, live `"Add item"` on active requests, Dashboard bulk pause/resume, instant template duplication, and white-label template builder preview.
- **Automated Test Pyramid:** Backend `node:test` suites, client Vitest + Testing Library tests, and Desktop/Mobile Playwright E2E + WCAG 2.2 AA `axe-core` gates across Light and Dark themes.
