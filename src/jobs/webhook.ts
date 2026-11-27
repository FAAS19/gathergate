import type { RequestRow, Store, WorkspaceRow } from "../db/queries.js";
import { decryptField, hmacSha256Hex } from "../security/crypto.js";
import { validateWebhookEndpointRuntime, type LookupAllFn } from "../security/ssrf.js";
import { maskSensitiveValue, SENSITIVE_VALIDATORS } from "../validators/index.js";

export function resolveWebhookSecret(
  workspace: Pick<WorkspaceRow, "id" | "webhook_secret">,
  masterKey?: Buffer
): string | null {
  const raw = workspace.webhook_secret?.trim();
  if (!raw) return null;
  if (raw.startsWith("v1:") && masterKey) {
    try {
      return decryptField(masterKey, raw, `${workspace.id}:webhook`);
    } catch {
      return null;
    }
  }
  return raw;
}

function buildSignedHeaders(secret: string | null, event: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "GatherGate/1.0 (TensorForge; contact@tensorforge.dev)",
    "x-gathergate-event": event,
    "x-gathergate-timestamp": ts,
  };
  if (secret) {
    const sig = hmacSha256Hex(secret, `${ts}.${body}`);
    headers["x-gathergate-signature"] = `t=${ts},v1=${sig}`;
  }
  return headers;
}

export async function dispatchCompletionWebhook(params: {
  store: Store;
  workspace: WorkspaceRow;
  request: RequestRow;
  masterKey: Buffer;
  baseUrl: string;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
}): Promise<{ dispatched: boolean; status?: number }> {
  const url = params.workspace.webhook_url?.trim();
  if (!url) return { dispatched: false };

  const ssrfErr = await validateWebhookEndpointRuntime(url, Boolean(params.multiTenant), {
    skipDns: Boolean(params.fetchImpl) && !params.lookupImpl,
    lookupImpl: params.lookupImpl,
  });
  if (ssrfErr) {
    params.store.logAudit(params.workspace.id, params.request.id, "system", "webhook.blocked", {
      reason: ssrfErr,
    });
    return { dispatched: false };
  }

  const items = params.store.listRequestItems(params.request.id);
  const uploads = params.store.listUploadsForRequest(params.request.id);

  // Never emit raw sensitive national IDs over third-party webhooks; mask sensitive fields.
  const payload = {
    event: "request.completed",
    timestamp: new Date().toISOString(),
    workspace: { id: params.workspace.id, name: params.workspace.name },
    request: {
      id: params.request.id,
      title: params.request.title,
      client_name: params.request.client_name,
      client_email: params.request.client_email,
      completed_at: params.request.completed_at,
      purge_at: params.request.purge_at,
      export_url: `${params.baseUrl}/api/requests/${params.request.id}/export.zip`,
    },
    items: items.map((item) => {
      let value: string | null = null;
      if (item.value_encrypted) {
        const plain = decryptField(params.masterKey, item.value_encrypted, item.id);
        value = SENSITIVE_VALIDATORS.has(item.validator)
          ? maskSensitiveValue(item.validator, plain)
          : plain;
      }
      const client_note = item.client_note_encrypted
        ? decryptField(params.masterKey, item.client_note_encrypted, `${item.id}:note`)
        : null;
      const itemFiles = uploads
        .filter((u) => u.request_item_id === item.id)
        .map((u) => ({
          id: u.id,
          canonical_name: u.canonical_name,
          detected_mime: u.detected_mime,
          size_bytes: u.size_bytes,
          sha256: u.sha256,
        }));
      return {
        id: item.id,
        section: item.section,
        label: item.label,
        kind: item.kind,
        validator: item.validator,
        status: item.status,
        value,
        client_na: item.client_na === 1,
        client_note,
        files: itemFiles,
      };
    }),
  };

  const body = JSON.stringify(payload);
  const webhookSecret = resolveWebhookSecret(params.workspace, params.masterKey);
  const headers = buildSignedHeaders(webhookSecret, "request.completed", body);

  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    params.store.logAudit(params.workspace.id, params.request.id, "system", "webhook.dispatched", {
      status: res.status,
      ok: res.ok,
    });
    return { dispatched: true, status: res.status };
  } catch (err) {
    params.store.logAudit(params.workspace.id, params.request.id, "system", "webhook.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { dispatched: false };
  }
}

export async function dispatchTestWebhook(params: {
  workspace: WorkspaceRow;
  masterKey?: Buffer;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = params.workspace.webhook_url?.trim();
  if (!url) return { ok: false, error: "No webhook URL configured" };

  const ssrfErr = await validateWebhookEndpointRuntime(url, Boolean(params.multiTenant), {
    skipDns: Boolean(params.fetchImpl) && !params.lookupImpl,
    lookupImpl: params.lookupImpl,
  });
  if (ssrfErr) return { ok: false, error: ssrfErr };

  const body = JSON.stringify({
    event: "webhook.test",
    timestamp: new Date().toISOString(),
    workspace: { id: params.workspace.id, name: params.workspace.name },
    message: "GatherGate HMAC-SHA256 webhook verification test.",
  });
  const webhookSecret = resolveWebhookSecret(params.workspace, params.masterKey);
  const headers = buildSignedHeaders(webhookSecret, "webhook.test", body);
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
