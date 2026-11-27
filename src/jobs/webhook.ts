import type {
  RequestItemRow,
  RequestRow,
  Store,
  UploadRow,
  WebhookDeliveryRow,
  WorkspaceRow,
} from "../db/queries.js";
import { decryptField, hmacSha256Hex } from "../security/crypto.js";
import { validateWebhookEndpointRuntime, type LookupAllFn } from "../security/ssrf.js";
import { maskSensitiveValue, SENSITIVE_VALIDATORS } from "../validators/index.js";

export const WEBHOOK_EVENTS = [
  "request.opened",
  "item.submitted",
  "request.in_review",
  "request.completed",
  "request.overdue",
  "request.purged",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Exponential backoff delays for the 5 retries after an initial failed attempt (total 6 attempts). */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000, // Retry 1: +1m
  300_000, // Retry 2: +5m
  900_000, // Retry 3: +15m
  3_600_000, // Retry 4: +1h
  21_600_000, // Retry 5: +6h
] as const;

export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

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

function buildSignedHeaders(
  secret: string | null,
  event: string,
  body: string,
  deliveryId?: string,
  nowMs = Date.now()
): Record<string, string> {
  const ts = Math.floor(nowMs / 1000).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "GatherGate/1.0 (TensorForge; contact@tensorforge.dev)",
    "x-gathergate-event": event,
    "x-gathergate-timestamp": ts,
  };
  if (deliveryId) {
    headers["x-gathergate-delivery"] = deliveryId;
  }
  if (secret) {
    const sig = hmacSha256Hex(secret, `${ts}.${body}`);
    headers["x-gathergate-signature"] = `t=${ts},v1=${sig}`;
  }
  return headers;
}

/** Never emit raw sensitive national IDs over third-party webhooks; always mask sensitive validators. */
function formatWebhookItem(
  item: RequestItemRow,
  uploads: UploadRow[],
  masterKey: Buffer
): Record<string, unknown> {
  let value: string | null = null;
  if (item.value_encrypted) {
    const plain = decryptField(masterKey, item.value_encrypted, item.id);
    value = SENSITIVE_VALIDATORS.has(item.validator)
      ? maskSensitiveValue(item.validator, plain)
      : plain;
  }
  const client_note = item.client_note_encrypted
    ? decryptField(masterKey, item.client_note_encrypted, `${item.id}:note`)
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
}

export async function attemptWebhookDelivery(params: {
  store: Store;
  delivery: WebhookDeliveryRow;
  masterKey: Buffer;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  nowMs?: number;
  isReplay?: boolean;
  workspaceOverride?: WorkspaceRow;
}): Promise<{ dispatched: boolean; status?: number; error?: string; delivery: WebhookDeliveryRow }> {
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const delivery = params.delivery;
  const workspace = params.workspaceOverride ?? params.store.getWorkspaceById(delivery.workspace_id);
  const url = workspace?.webhook_url?.trim() || "";

  if (!workspace || !url) {
    const updated = params.store.updateWebhookDeliveryAttempt({
      id: delivery.id,
      targetUrl: delivery.target_url,
      status: "dead_letter",
      attempts: delivery.attempts + 1,
      lastStatusCode: null,
      lastError: "No webhook URL configured.",
      nextAttemptAt: null,
      deliveredAt: null,
      nowIso,
    });
    return { dispatched: false, error: "No webhook URL configured.", delivery: updated };
  }

  const ssrfErr = await validateWebhookEndpointRuntime(url, Boolean(params.multiTenant), {
    skipDns: Boolean(params.fetchImpl) && !params.lookupImpl,
    lookupImpl: params.lookupImpl,
  });
  if (ssrfErr) {
    const updated = params.store.updateWebhookDeliveryAttempt({
      id: delivery.id,
      targetUrl: url,
      status: "dead_letter",
      attempts: delivery.attempts + 1,
      lastStatusCode: null,
      lastError: ssrfErr,
      nextAttemptAt: null,
      deliveredAt: null,
      nowIso,
    });
    params.store.logAudit(workspace.id, delivery.request_id, "system", "webhook.blocked", {
      deliveryId: delivery.id,
      event: delivery.event,
      reason: ssrfErr,
    });
    return { dispatched: false, error: ssrfErr, delivery: updated };
  }

  const webhookSecret = resolveWebhookSecret(workspace, params.masterKey);
  const headers = buildSignedHeaders(webhookSecret, delivery.event, delivery.payload_json, delivery.id, nowMs);
  const doFetch = params.fetchImpl ?? fetch;
  const nextAttemptNumber = delivery.attempts + 1;

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: delivery.payload_json,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});

    if (res.ok) {
      const updated = params.store.updateWebhookDeliveryAttempt({
        id: delivery.id,
        targetUrl: url,
        status: "delivered",
        attempts: nextAttemptNumber,
        lastStatusCode: res.status,
        lastError: null,
        nextAttemptAt: null,
        deliveredAt: nowIso,
        nowIso,
      });
      params.store.logAudit(workspace.id, delivery.request_id, "system", "webhook.dispatched", {
        deliveryId: delivery.id,
        event: delivery.event,
        status: res.status,
        attempt: nextAttemptNumber,
        ok: true,
      });
      return { dispatched: true, status: res.status, delivery: updated };
    }

    const errText = `HTTP ${res.status}`;
    const keepScheduledRetry = Boolean(
      params.isReplay && delivery.status === "retrying" && delivery.next_attempt_at
    );
    const shouldRetry = !params.isReplay && nextAttemptNumber < delivery.max_attempts;
    const delayMs = WEBHOOK_RETRY_DELAYS_MS[Math.min(nextAttemptNumber - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
    const updated = params.store.updateWebhookDeliveryAttempt({
      id: delivery.id,
      targetUrl: url,
      status: shouldRetry || keepScheduledRetry ? "retrying" : "dead_letter",
      attempts: nextAttemptNumber,
      lastStatusCode: res.status,
      lastError: errText,
      nextAttemptAt: shouldRetry
        ? new Date(nowMs + delayMs).toISOString()
        : keepScheduledRetry
          ? delivery.next_attempt_at
          : null,
      deliveredAt: null,
      nowIso,
    });
    params.store.logAudit(workspace.id, delivery.request_id, "system", "webhook.failed", {
      deliveryId: delivery.id,
      event: delivery.event,
      status: res.status,
      attempt: nextAttemptNumber,
      nextStatus: updated.status,
    });
    return { dispatched: false, status: res.status, error: errText, delivery: updated };
  } catch (err) {
    const errText = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const keepScheduledRetry = Boolean(
      params.isReplay && delivery.status === "retrying" && delivery.next_attempt_at
    );
    const shouldRetry = !params.isReplay && nextAttemptNumber < delivery.max_attempts;
    const delayMs = WEBHOOK_RETRY_DELAYS_MS[Math.min(nextAttemptNumber - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
    const updated = params.store.updateWebhookDeliveryAttempt({
      id: delivery.id,
      targetUrl: url,
      status: shouldRetry || keepScheduledRetry ? "retrying" : "dead_letter",
      attempts: nextAttemptNumber,
      lastStatusCode: null,
      lastError: errText,
      nextAttemptAt: shouldRetry
        ? new Date(nowMs + delayMs).toISOString()
        : keepScheduledRetry
          ? delivery.next_attempt_at
          : null,
      deliveredAt: null,
      nowIso,
    });
    params.store.logAudit(workspace.id, delivery.request_id, "system", "webhook.failed", {
      deliveryId: delivery.id,
      event: delivery.event,
      error: errText,
      attempt: nextAttemptNumber,
      nextStatus: updated.status,
    });
    return { dispatched: false, error: errText, delivery: updated };
  }
}

export async function dispatchWebhookEvent(params: {
  store: Store;
  workspace: WorkspaceRow;
  request: RequestRow;
  event: WebhookEventType;
  masterKey: Buffer;
  baseUrl: string;
  item?: RequestItemRow;
  filesDeleted?: number;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  nowMs?: number;
}): Promise<{ dispatched: boolean; status?: number; delivery?: WebhookDeliveryRow }> {
  const url = params.workspace.webhook_url?.trim();
  if (!url) return { dispatched: false };

  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const basePayload = {
    event: params.event,
    timestamp: nowIso,
    workspace: { id: params.workspace.id, name: params.workspace.name },
  };

  let payload: Record<string, unknown>;
  if (params.event === "request.completed") {
    const items = params.store.listRequestItems(params.request.id);
    const uploads = params.store.listUploadsForRequest(params.request.id);
    payload = {
      ...basePayload,
      request: {
        id: params.request.id,
        title: params.request.title,
        client_name: params.request.client_name,
        client_email: params.request.client_email,
        completed_at: params.request.completed_at,
        purge_at: params.request.purge_at,
        export_url: `${params.baseUrl}/api/requests/${params.request.id}/export.zip`,
      },
      items: items.map((it) => formatWebhookItem(it, uploads, params.masterKey)),
    };
  } else if (params.event === "request.opened") {
    payload = {
      ...basePayload,
      request: {
        id: params.request.id,
        title: params.request.title,
        client_name: params.request.client_name,
        client_email: params.request.client_email,
        status: params.request.status,
        due_at: params.request.due_at,
        opened_at: params.request.last_opened_at ?? nowIso,
      },
    };
  } else if (params.event === "item.submitted" && params.item) {
    const uploads = params.store.listUploadsForRequest(params.request.id);
    payload = {
      ...basePayload,
      request: {
        id: params.request.id,
        title: params.request.title,
        client_name: params.request.client_name,
        client_email: params.request.client_email,
        status: params.request.status,
      },
      item: formatWebhookItem(params.item, uploads, params.masterKey),
    };
  } else if (params.event === "request.in_review") {
    const items = params.store.listRequestItems(params.request.id);
    payload = {
      ...basePayload,
      request: {
        id: params.request.id,
        title: params.request.title,
        client_name: params.request.client_name,
        client_email: params.request.client_email,
        status: params.request.status,
        due_at: params.request.due_at,
        total_items: items.length,
        submitted_items: items.filter((i) => i.status === "submitted").length,
        approved_items: items.filter((i) => i.status === "approved").length,
      },
    };
  } else if (params.event === "request.overdue") {
    const items = params.store.listRequestItems(params.request.id);
    const outstanding = items.filter((i) => i.status === "pending" || i.status === "rejected").length;
    payload = {
      ...basePayload,
      request: {
        id: params.request.id,
        title: params.request.title,
        client_name: params.request.client_name,
        client_email: params.request.client_email,
        status: params.request.status,
        due_at: params.request.due_at,
        reminders_sent: params.request.reminders_sent,
        outstanding_items: outstanding,
      },
    };
  } else {
    // request.purged: emit metadata only; sensitive fields and files have been shredded.
    payload = {
      ...basePayload,
      request: {
        id: params.request.id,
        title: params.request.title,
        status: "purged",
        purged_at: nowIso,
        files_deleted: params.filesDeleted ?? 0,
      },
    };
  }

  const delivery = params.store.createWebhookDelivery({
    workspaceId: params.workspace.id,
    requestId: params.request.id,
    event: params.event,
    targetUrl: url,
    payloadJson: JSON.stringify(payload),
    maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    nowIso,
  });

  return attemptWebhookDelivery({
    store: params.store,
    delivery,
    masterKey: params.masterKey,
    multiTenant: params.multiTenant,
    fetchImpl: params.fetchImpl,
    lookupImpl: params.lookupImpl,
    nowMs,
    workspaceOverride: params.workspace,
  });
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
  nowMs?: number;
}): Promise<{ dispatched: boolean; status?: number; delivery?: WebhookDeliveryRow }> {
  return dispatchWebhookEvent({ ...params, event: "request.completed" });
}

export async function runWebhookRetrySweep(params: {
  store: Store;
  masterKey: Buffer;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  nowIso?: string;
  limit?: number;
}): Promise<{ processed: number; delivered: number; retrying: number; deadLetter: number }> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const due = params.store.listDueWebhookDeliveries(nowIso, params.limit ?? 50);
  let delivered = 0;
  let retrying = 0;
  let deadLetter = 0;

  for (const row of due) {
    const res = await attemptWebhookDelivery({
      store: params.store,
      delivery: row,
      masterKey: params.masterKey,
      multiTenant: params.multiTenant,
      fetchImpl: params.fetchImpl,
      lookupImpl: params.lookupImpl,
      nowMs,
    });
    if (res.delivery.status === "delivered") delivered += 1;
    else if (res.delivery.status === "retrying") retrying += 1;
    else if (res.delivery.status === "dead_letter") deadLetter += 1;
  }

  return { processed: due.length, delivered, retrying, deadLetter };
}

export async function runOverdueSweep(params: {
  store: Store;
  masterKey: Buffer;
  baseUrl: string;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  nowIso?: string;
}): Promise<number> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const overdue = params.store.listNewlyOverdueRequests(nowIso);
  let notified = 0;

  for (const req of overdue) {
    if (!params.store.markRequestOverdueNotified(req.id, nowIso)) continue;
    params.store.logAudit(req.workspace_id, req.id, "system", "request.overdue", {
      dueAt: req.due_at,
    });
    const workspace = params.store.getWorkspaceById(req.workspace_id);
    if (workspace?.webhook_url?.trim()) {
      await dispatchWebhookEvent({
        store: params.store,
        workspace,
        request: req,
        event: "request.overdue",
        masterKey: params.masterKey,
        baseUrl: params.baseUrl,
        multiTenant: params.multiTenant,
        fetchImpl: params.fetchImpl,
        lookupImpl: params.lookupImpl,
        nowMs,
      });
    }
    notified += 1;
  }

  return notified;
}

export async function replayWebhookDelivery(params: {
  store: Store;
  workspace: WorkspaceRow;
  delivery: WebhookDeliveryRow;
  masterKey: Buffer;
  actorEmail: string;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  nowMs?: number;
}): Promise<{ ok: boolean; status?: number; error?: string; delivery: WebhookDeliveryRow }> {
  const res = await attemptWebhookDelivery({
    store: params.store,
    delivery: params.delivery,
    masterKey: params.masterKey,
    multiTenant: params.multiTenant,
    fetchImpl: params.fetchImpl,
    lookupImpl: params.lookupImpl,
    nowMs: params.nowMs,
    isReplay: true,
    workspaceOverride: params.workspace,
  });
  params.store.logAudit(params.workspace.id, params.delivery.request_id, "operator", "webhook.replayed", {
    deliveryId: params.delivery.id,
    event: params.delivery.event,
    by: params.actorEmail,
    ok: res.dispatched,
    status: res.status ?? null,
  });
  return { ok: res.dispatched, status: res.status, error: res.error, delivery: res.delivery };
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
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
