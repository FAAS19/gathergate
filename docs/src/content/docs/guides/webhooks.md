---
title: Signed Webhooks & n8n
description: Trigger downstream workflows when a client pack is approved and verify HMAC-SHA256 signatures safely.
---

When an operator approves the final required item in a request (moving status to `completed`), GatherGate sends an HTTP `POST` JSON webhook to your workspace's configured **Webhook URL** (**Settings > Webhooks**).

## Security Design

- **Encrypted signing secret**: Your webhook secret is encrypted at rest with HKDF-SHA256 + AES-256-GCM in SQLite.
- **Masked sensitive IDs**: Sensitive national IDs (`au_tfn_mod11`, `au_medicare_mod10`, `uk_nino`, `us_ssn`) are **always masked** in webhook payloads (e.g. `****** 789`). Raw sensitive fields are never broadcast to third-party automation endpoints.
- **No redirects & bounded timeout**: Outbound requests use `redirect: "error"` and a 10-second `AbortSignal.timeout`. In `MULTI_TENANT=true`, private/loopback/link-local targets are blocked after DNS resolution.

## Request Headers

Every delivery includes these headers:

```http
Content-Type: application/json
User-Agent: GatherGate/1.0 (TensorForge; contact@tensorforge.dev)
X-GatherGate-Event: request.completed
X-GatherGate-Timestamp: 1764240000
X-GatherGate-Signature: t=1764240000,v1=<hex-hmac-sha256>
```

The test button in Settings sends `X-GatherGate-Event: webhook.test`.

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
  if (!Number.isFinite(ts) || !v1) return false;
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
2. Add a **Code** node immediately after it running the signature check against `$env.GATHERGATE_WEBHOOK_SECRET` and failing closed on mismatch.
3. Route valid `request.completed` payloads to Slack, Xero, Cliniko, or your document management system.
