# Changelog

All notable changes to GatherGate are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Trunk-based contributor workflow (`CONTRIBUTING.md`), security policy and threat model (`SECURITY.md`), GitHub Actions CI (`ci.yml`), SemVer multi-arch GHCR release workflow (`release.yml`), issue/PR templates, and Dependabot configuration.

### Changed

### Fixed

### Security

## [0.1.0] - 2026-11-22

### Added
- **Core Vault & Auth:** Self-hosted Node.js + Hono JSON API, SQLite WAL (`node:sqlite`), Argon2id/scrypt operator auth, per-record HKDF AES-256-GCM encryption at rest, magic-byte file verification, streaming decrypted ZIP export, HMAC-SHA256 completion webhooks, Local Email Outbox, and single-container Docker build.
- **Validator Packs (Milestone 1):** Pluggable validator registry with generic (`email`, `url`, `phone_e164`, `iban`) and Australian statutory (`au_abn_mod89`, `au_bsb`, `au_tfn_mod11`, `au_medicare_mod10`, `au_phone_e164`) packs; unknown validators fail closed.
- **White-Label Client Portal (Milestone 1):** Split-screen `/setup` with live portal preview, workspace branding (logo, WCAG-checked accent colour, support email/phone), branded HTML + plain-text emails, XHR upload progress bar, file delete/replace before approval, encrypted client notes and "Not applicable" escape hatch, mobile camera upload, and jump sheet.
- **High-Velocity Operator Console (Milestone 2):** Continuous document review sheet (`Prev`/`Next`, 75%-200% zoom, `Approve & next`, `Request revision`), keyboard-first triage (`J`/`K`/`Space`/`A`/`R`/`Esc`/`?`), optimistic updates with functional-updater rollback, manual `"Send reminder now"` with 15-minute cooldown, inline due-date editing, live `"Add item"` on active requests, Dashboard bulk pause/resume, instant template duplication, and white-label template builder preview.
- **Automated Test Pyramid:** Backend `node:test` suites, client Vitest + Testing Library tests, and Desktop/Mobile Playwright E2E + WCAG 2.2 AA `axe-core` gates across Light and Dark themes.
