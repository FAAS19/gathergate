---
title: Signed Webhooks, Retry Queue & API Keys
description: Trigger downstream workflows across 6 request lifecycle events, inspect and replay failed deliveries, and automate securely with scoped workspace API keys.
---

GatherGate sends HMAC-SHA256 signed HTTP `POST` JSON webhooks to your workspace's configured **Webhook URL** (**Settings > Webhooks**) across the full request lifecycle, backed by a durable SQLite retry queue and dead-letter replay log.

## Supported Webhook Events

| Event | Trigger |
| :--- | :--- |
| `request.opened` | Client opens a magic-link checklist for the first time (recorded atomically once per request). |
| `item.submitted` | Client submits a text answer, uploads a file, or marks an optional item Not applicable. |
| `request.in_review` | All required items are submitted and the pack enters operator review. |
| `request.completed` | Operator approves the final required item and the pack reaches `completed`. |
| `request.overdue` | Active pack passes its `due_at` deadline during the scheduled sweep (deduplicated per deadline). |
| `request.purged` | Encrypted payload and uploaded blobs are shredded after retention expiry (prior `webhook_deliveries` payloads are shredded first, then a minimal metadata-only `request.purged` event is queued and dispatched). |

The test button in **Settings > Webhooks** sends `X-GatherGate-Event: webhook.test`.

## Security Design

- **Encrypted signing secret**: Your webhook secret is encrypted at rest with HKDF-SHA256 + AES-256-GCM in SQLite.
- **Masked sensitive IDs**: Sensitive national IDs (`au_tfn_mod11`, `au_medicare_mod10`, `uk_nino`, `us_ssn`) are **always masked** in webhook payloads (e.g. `****** 789`). Raw sensitive values are never broadcast to third-party automation endpoints.
- **DNS-pinned delivery & zero redirects**: Outbound requests use `redirect: "error"` and a 10-second timeout. In `MULTI_TENANT=true`, private, loopback, and link-local IP ranges are blocked after DNS resolution and connections pin directly to verified public IPs (mitigating DNS rebinding).
- **Pre-purge shredding**: When a request is purged, its prior stored `webhook_deliveries` payload rows are shredded from SQLite first, then a minimal metadata-only `request.purged` event is inserted and dispatched.

## Durable Retry Queue & Manual Replay

Every lifecycle event is written to the `webhook_deliveries` table in SQLite before dispatch:

- **5 exponential retries**: Transient 5xx, 429, timeout, or network failures automatically retry at **1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours** (6 total attempts).
- **Dead-letter queue**: Exhausted deliveries move to `dead_letter`.
- **Inspect & replay**: Filter recent deliveries in **Settings > Webhooks** (`All`, `Dead letter`, `Retrying`, `Delivered`) and trigger one-click **Replay** (the session-authenticated API `GET /api/settings/webhook/deliveries?status=...` also accepts `pending` and `in_flight`, alongside `POST /api/settings/webhook/deliveries/:id/replay`).

## Request Headers

Every delivery includes these headers:

```http
Content-Type: application/json
User-Agent: GatherGate/1.1 (TensorForge; contact@tensorforge.dev)
X-GatherGate-Event: request.completed
X-GatherGate-Delivery: whd_01J...
X-GatherGate-Timestamp: 1764240000
X-GatherGate-Signature: t=1764240000,v1=<hex-hmac-sha256>
```

Use `X-GatherGate-Delivery` as your idempotency key so retried deliveries never duplicate downstream work.

## Payload Shape (`request.completed`)

```json
{
  "event": "request.completed",
  "timestamp": "2026-11-27T10:00:00.000Z",
  "workspace": {
    "id": "ws_...",
    "name": "Harbour Advisory"
  },
  "request": {
    "id": "req_...",
    "title": "FY26 Individual Tax Return Pack",
    "client_name": "Claire Nguyen",
    "client_email": "claire@example.com.au",
    "completed_at": "2026-11-27T10:00:00.000Z",
    "purge_at": "2026-12-11T10:00:00.000Z",
    "export_url": "https://intake.yourfirm.com.au/api/requests/req_.../export.zip"
  },
  "items": [
    {
      "id": "itm_...",
      "section": "Identity & ATO Details",
      "label": "Tax File Number (TFN)",
      "kind": "text",
      "validator": "au_tfn_mod11",
      "status": "approved",
      "value": "****** 789",
      "client_na": false,
      "client_note": null,
      "files": []
    }
  ]
}
```

## Verifying the Signature (Node.js / n8n Code Node)

Compute `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`, verify timestamp freshness (within 5 minutes), and compare using `crypto.timingSafeEqual`:

```js
import crypto from "node:crypto";

export function verifyGatherGateWebhook(rawBody, signatureHeader, secret, maxAgeSec = 300) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.split("=").map((s) => s.trim()))
  );
  const ts = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(ts) || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > maxAgeSec) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

### Using with n8n

1. Add a **Webhook** trigger node (`POST`, Raw Body enabled under Options).
2. Add a **Code** node immediately after it running the signature check against `$env.GATHERGATE_WEBHOOK_SECRET`, deduplicating on `X-GatherGate-Delivery`, and failing closed on mismatch.
3. Route verified events (`request.completed`, `request.overdue`, `item.submitted`) to Slack, Xero, Cliniko, or your document management system.

## Scoped Workspace API Keys

For headless automation and n8n HTTP Request nodes, create least-privilege Bearer tokens (`gg_live_...`) under **Settings > API Keys**:

| Scope | Permitted Operations |
| :--- | :--- |
| `templates:read` | `GET /api/templates` |
| `requests:read` | `GET /api/requests`, `GET /api/requests/:id`, `GET /api/clients`, `GET /api/validators` (sensitive IDs remain masked; `portal_url`, `portalUrl`, and `demoPortalUrl` are redacted unless the key also holds `requests:write`) |
| `requests:write` | `POST /api/requests`, `PATCH /api/requests/:id`, `POST /api/requests/:id/items`, `POST /api/requests/:id/items/:itemId/review`, `POST /api/requests/:id/approve-all-submitted`, `POST /api/requests/:id/remind-now`, `POST /api/requests/:id/toggle-reminders`, `POST /api/requests/bulk-reminders` |
| `mcp:read` | Access `POST /mcp` read tools and bundled `SKILL.md` resources (combine with `requests:write` for MCP write tools) |

Keys are stored strictly as SHA-256 hashes (shown once at creation), support optional expiry dates and instant revocation, and are blocked from session-only routes (Settings, API key management, raw sensitive ID reveal, file downloads, and `export.zip`).
