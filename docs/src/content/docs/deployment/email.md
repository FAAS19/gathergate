---
title: Email Delivery
description: Configure Local Outbox, SMTP (Gmail, Outlook/M365, Fastmail, SES), or Resend for magic-link invites, OTP codes, and reminders.
---

GatherGate supports three outbound email drivers: **Local Outbox** (`console`), **SMTP**, and **Resend**. You can configure defaults via `.env` or manage per-workspace settings directly in the UI under **Settings > Email Delivery**.

## 1. Local Outbox (`console`, Default)

Zero setup required. Outbound invites, 6-digit OTP verification codes, and automated chasers are saved locally in SQLite and viewable in **Local Outbox** (`/outbox`) inside a sandboxed (`sandbox=""`) preview iframe.

```dotenv
EMAIL_BACKEND=console
EMAIL_FROM=GatherGate <noreply@localhost>
```

Ideal for local evaluation, offline tests, and checking your branded email templates before connecting a live mail provider.

## 2. In-App Configuration (Recommended)

Open **Settings > Email Delivery** inside GatherGate:

1. Select **SMTP** (includes presets for Gmail, Outlook / Microsoft 365, Fastmail, Amazon SES, or Custom) or **Resend**.
2. Enter your credentials, `From` address, and optional `Reply-To` address.
3. Click **Save**, then click **Send test email** to verify delivery.

Secrets saved through **Settings > Email Delivery** are encrypted at rest with HKDF-SHA256 + AES-256-GCM bound to your workspace ID and are never returned in `GET /api/settings`.

## 3. Environment Variable Defaults

### Resend

Use a domain-scoped **Sending access** API key (never a full-access key):

```dotenv
EMAIL_BACKEND=resend
EMAIL_FROM=Intake <intake@yourfirm.com.au>
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
```

### SMTP

```dotenv
EMAIL_BACKEND=smtp
EMAIL_FROM=Intake <intake@yourfirm.com.au>
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=intake@yourfirm.com.au
SMTP_PASS=your-app-password
```

- Use `SMTP_SECURE=true` for implicit TLS (`465`) and `SMTP_SECURE=false` for STARTTLS (`587`).
- Ensure SPF, DKIM, and DMARC records are configured on your sending domain so magic-link invites and 6-digit OTP emails land in client inboxes rather than spam.

## Multi-Tenant Email Isolation

When `MULTI_TENANT=true`, GatherGate blocks private, loopback, and link-local SMTP hostnames (with DNS resolution checks on both test and live sends) to prevent SSRF, and workspaces cannot inherit host-level SMTP secrets.
