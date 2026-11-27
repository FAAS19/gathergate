import https from "node:https";
import type {
  RequestItemRow,
  RequestRow,
  Store,
  UploadRow,
  WebhookDeliveryRow,
  WorkspaceRow,
} from "../db/queries.js";
import { decryptField, generateId, hmacSha256Hex } from "../security/crypto.js";
import { resolveWebhookEndpointRuntime, type LookupAllFn } from "../security/ssrf.js";
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
const IN_FLIGHT_LEASE_MS = 120_000;

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

function safeLogAudit(
  store: Store,
  workspaceId: string,
  requestId: string | null,
  actor: "operator" | "client" | "system" | "api_key",
  action: string,
  meta: Record<string, unknown>
): void {
  try {
    store.logAudit(workspaceId, requestId, actor, action, meta);
  } catch (err) {
    console.error(`[GatherGate Webhook] failed to write audit event ${action}:`, err);
  }
}

/**
 * Pins the HTTPS socket directly to the pre-validated public IP address while preserving
 * the original hostname for TLS SNI, certificate validation, and the HTTP Host header.
 * Raw node:https never follows redirects.
 */
function postPinnedHttps(params: {
  url: string;
  headers: Record<string, string>;
  body: string;
  resolvedAddress: string;
  family: 4 | 6;
  timeoutMs: number;
}): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(params.url);
    const bodyBuf = Buffer.from(params.body, "utf8");
    const req = https.request(
      {
        protocol: "https:",
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        servername: parsed.hostname,
        headers: {
          ...params.headers,
          host: parsed.host,
          "content-length": String(bodyBuf.byteLength),
        },
        lookup: ((_host: string, opts: unknown, cb: (...args: unknown[]) => void) => {
          if (opts && typeof opts === "object" && "all" in opts && (opts as { all?: boolean }).all) {
            cb(null, [{ address: params.resolvedAddress, family: params.family }]);
          } else {
            cb(null, params.resolvedAddress, params.family);
          }
        }) as unknown as import("node:net").LookupFunction,
        signal: AbortSignal.timeout(params.timeoutMs),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        resolve({ ok: status >= 200 && status < 300, status });
      }
    );
    req.on("error", reject);
    req.end(bodyBuf);
  });
}

async function postWebhookRequest(params: {
  url: string;
  headers: Record<string, string>;
  body: string;
  multiTenant: boolean;
  resolvedAddress?: string;
  family?: 4 | 6;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    if (!params.fetchImpl && params.multiTenant && params.resolvedAddress && params.family) {
      const res = await postPinnedHttps({
        url: params.url,
        headers: params.headers,
        body: params.body,
        resolvedAddress: params.resolvedAddress,
        family: params.family,
        timeoutMs: 10_000,
      });
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const doFetch = params.fetchImpl ?? fetch;
    const res = await doFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: params.body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
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

export function buildWebhookEventPayload(params: {
  store: Store;
  workspace: WorkspaceRow;
  request: RequestRow;
  event: WebhookEventType;
  masterKey: Buffer;
  baseUrl: string;
  nowIso: string;
  openedAt?: string;
  item?: RequestItemRow;
  filesDeleted?: number;
}): string {
  const basePayload = {
    event: params.event,
    timestamp: params.nowIso,
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
        opened_at: params.openedAt ?? params.request.last_opened_at ?? params.nowIso,
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
    // request.purged: metadata only; sensitive fields and files have been shredded.
    payload = {
      ...basePayload,
      request: {
        id: params.request.id,
        title: params.request.title,
        status: "purged",
        purged_at: params.nowIso,
        files_deleted: params.filesDeleted ?? 0,
      },
    };
  }

  return JSON.stringify(payload);
}

function computeFailureSchedule(params: {
  isReplay: boolean;
  priorStatus: WebhookDeliveryRow["status"];
  priorNextAttemptAt: string | null;
  nextAttemptNumber: number;
  maxAttempts: number;
  nowMs: number;
}): { status: "retrying" | "dead_letter"; nextAttemptAt: string | null } {
  const keepScheduledRetry = Boolean(
    params.isReplay && params.priorStatus === "retrying" && params.priorNextAttemptAt
  );
  const shouldRetry = !params.isReplay && params.nextAttemptNumber < params.maxAttempts;
  if (shouldRetry) {
    const delayMs =
      WEBHOOK_RETRY_DELAYS_MS[
        Math.min(params.nextAttemptNumber - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)
      ];
    return { status: "retrying", nextAttemptAt: new Date(params.nowMs + delayMs).toISOString() };
  }
  if (keepScheduledRetry) {
    return { status: "retrying", nextAttemptAt: params.priorNextAttemptAt };
  }
  return { status: "dead_letter", nextAttemptAt: null };
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
}): Promise<{
  dispatched: boolean;
  skipped?: boolean;
  status?: number;
  error?: string;
  delivery: WebhookDeliveryRow;
}> {
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const priorDelivery = params.delivery;
  const claimToken = `${nowIso}:${generateId("clm")}`;
  const leaseUntilIso = new Date(nowMs + IN_FLIGHT_LEASE_MS).toISOString();

  // Atomically claim the row before any await so immediate dispatch and cron sweeps cannot race.
  const claimed = params.store.claimWebhookDelivery({
    id: priorDelivery.id,
    expectedUpdatedAt: priorDelivery.updated_at,
    claimToken,
    leaseUntilIso,
    isReplay: Boolean(params.isReplay),
  });
  if (!claimed) {
    return {
      dispatched: false,
      skipped: true,
      delivery: params.store.getWebhookDeliveryById(priorDelivery.id) ?? priorDelivery,
    };
  }

  const workspace = params.workspaceOverride ?? params.store.getWorkspaceById(priorDelivery.workspace_id);
  const url = workspace?.webhook_url?.trim() || "";
  const nextAttemptNumber = priorDelivery.attempts + 1;

  if (!workspace || !url) {
    const updated = params.store.completeWebhookDeliveryAttempt({
      id: priorDelivery.id,
      claimToken,
      targetUrl: priorDelivery.target_url,
      status: "dead_letter",
      attempts: nextAttemptNumber,
      lastStatusCode: null,
      lastError: "No webhook URL configured.",
      nextAttemptAt: null,
      deliveredAt: null,
      nowIso,
    });
    return { dispatched: false, error: "No webhook URL configured.", delivery: updated };
  }

  const resolved = await resolveWebhookEndpointRuntime(url, Boolean(params.multiTenant), {
    skipDns: Boolean(params.fetchImpl) && !params.lookupImpl,
    lookupImpl: params.lookupImpl,
  });
  if (!resolved.ok) {
    if (resolved.kind === "transient_dns") {
      const schedule = computeFailureSchedule({
        isReplay: Boolean(params.isReplay),
        priorStatus: priorDelivery.status,
        priorNextAttemptAt: priorDelivery.next_attempt_at,
        nextAttemptNumber,
        maxAttempts: priorDelivery.max_attempts,
        nowMs,
      });
      const updated = params.store.completeWebhookDeliveryAttempt({
        id: priorDelivery.id,
        claimToken,
        targetUrl: url,
        status: schedule.status,
        attempts: nextAttemptNumber,
        lastStatusCode: null,
        lastError: resolved.error,
        nextAttemptAt: schedule.nextAttemptAt,
        deliveredAt: null,
        nowIso,
      });
      safeLogAudit(params.store, workspace.id, priorDelivery.request_id, "system", "webhook.failed", {
        deliveryId: priorDelivery.id,
        event: priorDelivery.event,
        error: resolved.error,
        attempt: nextAttemptNumber,
        nextStatus: updated.status,
      });
      return { dispatched: false, error: resolved.error, delivery: updated };
    }

    const updated = params.store.completeWebhookDeliveryAttempt({
      id: priorDelivery.id,
      claimToken,
      targetUrl: url,
      status: "dead_letter",
      attempts: nextAttemptNumber,
      lastStatusCode: null,
      lastError: resolved.error,
      nextAttemptAt: null,
      deliveredAt: null,
      nowIso,
    });
    safeLogAudit(params.store, workspace.id, priorDelivery.request_id, "system", "webhook.blocked", {
      deliveryId: priorDelivery.id,
      event: priorDelivery.event,
      reason: resolved.error,
    });
    return { dispatched: false, error: resolved.error, delivery: updated };
  }

  const webhookSecret = resolveWebhookSecret(workspace, params.masterKey);
  const headers = buildSignedHeaders(
    webhookSecret,
    priorDelivery.event,
    priorDelivery.payload_json,
    priorDelivery.id,
    nowMs
  );

  // Isolate network I/O errors so downstream audit/DB logging can never reschedule an accepted 2xx POST.
  const sendRes = await postWebhookRequest({
    url,
    headers,
    body: priorDelivery.payload_json,
    multiTenant: Boolean(params.multiTenant),
    resolvedAddress: resolved.resolvedAddress,
    family: resolved.family,
    fetchImpl: params.fetchImpl,
  });

  if (sendRes.ok) {
    const updated = params.store.completeWebhookDeliveryAttempt({
      id: priorDelivery.id,
      claimToken,
      targetUrl: url,
      status: "delivered",
      attempts: nextAttemptNumber,
      lastStatusCode: sendRes.status ?? 200,
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: nowIso,
      nowIso,
    });
    safeLogAudit(params.store, workspace.id, priorDelivery.request_id, "system", "webhook.dispatched", {
      deliveryId: priorDelivery.id,
      event: priorDelivery.event,
      status: sendRes.status ?? 200,
      attempt: nextAttemptNumber,
      ok: true,
    });
    return { dispatched: true, status: sendRes.status, delivery: updated };
  }

  const schedule = computeFailureSchedule({
    isReplay: Boolean(params.isReplay),
    priorStatus: priorDelivery.status,
    priorNextAttemptAt: priorDelivery.next_attempt_at,
    nextAttemptNumber,
    maxAttempts: priorDelivery.max_attempts,
    nowMs,
  });
  const updated = params.store.completeWebhookDeliveryAttempt({
    id: priorDelivery.id,
    claimToken,
    targetUrl: url,
    status: schedule.status,
    attempts: nextAttemptNumber,
    lastStatusCode: sendRes.status ?? null,
    lastError: sendRes.error ?? "Delivery failed",
    nextAttemptAt: schedule.nextAttemptAt,
    deliveredAt: null,
    nowIso,
  });
  safeLogAudit(params.store, workspace.id, priorDelivery.request_id, "system", "webhook.failed", {
    deliveryId: priorDelivery.id,
    event: priorDelivery.event,
    status: sendRes.status ?? null,
    error: sendRes.error ?? "Delivery failed",
    attempt: nextAttemptNumber,
    nextStatus: updated.status,
  });
  return {
    dispatched: false,
    status: sendRes.status,
    error: sendRes.error,
    delivery: updated,
  };
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
  const payloadJson = buildWebhookEventPayload({
    store: params.store,
    workspace: params.workspace,
    request: params.request,
    event: params.event,
    masterKey: params.masterKey,
    baseUrl: params.baseUrl,
    nowIso,
    item: params.item,
    filesDeleted: params.filesDeleted,
  });

  const delivery = params.store.createWebhookDelivery({
    workspaceId: params.workspace.id,
    requestId: params.request.id,
    event: params.event,
    targetUrl: url,
    payloadJson,
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
  let processed = 0;
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
    if (res.skipped) continue;
    processed += 1;
    if (res.delivery.status === "delivered") delivered += 1;
    else if (res.delivery.status === "retrying") retrying += 1;
    else if (res.delivery.status === "dead_letter") deadLetter += 1;
  }

  return { processed, delivered, retrying, deadLetter };
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
    if (!req.due_at) continue;
    const workspace = params.store.getWorkspaceById(req.workspace_id);
    const targetUrl = workspace?.webhook_url?.trim() || "";
    const webhookDelivery =
      workspace && targetUrl
        ? {
            targetUrl,
            payloadJson: buildWebhookEventPayload({
              store: params.store,
              workspace,
              request: req,
              event: "request.overdue",
              masterKey: params.masterKey,
              baseUrl: params.baseUrl,
              nowIso,
            }),
            maxAttempts: MAX_WEBHOOK_ATTEMPTS,
          }
        : null;

    // Atomically verify due_at still matches, set overdue_notified_at, log audit, and queue delivery.
    const claimed = params.store.claimOverdueNotification({
      requestId: req.id,
      workspaceId: req.workspace_id,
      expectedDueAt: req.due_at,
      nowIso,
      webhookDelivery,
    });
    if (!claimed.claimed) continue;

    if (claimed.delivery && workspace) {
      await attemptWebhookDelivery({
        store: params.store,
        delivery: claimed.delivery,
        masterKey: params.masterKey,
        multiTenant: params.multiTenant,
        fetchImpl: params.fetchImpl,
        lookupImpl: params.lookupImpl,
        nowMs,
        workspaceOverride: workspace,
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
  if (res.skipped) {
    return {
      ok: false,
      error: "Delivery is already in progress. Try again shortly.",
      delivery: res.delivery,
    };
  }
  safeLogAudit(params.store, params.workspace.id, params.delivery.request_id, "operator", "webhook.replayed", {
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

  const resolved = await resolveWebhookEndpointRuntime(url, Boolean(params.multiTenant), {
    skipDns: Boolean(params.fetchImpl) && !params.lookupImpl,
    lookupImpl: params.lookupImpl,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const body = JSON.stringify({
    event: "webhook.test",
    timestamp: new Date().toISOString(),
    workspace: { id: params.workspace.id, name: params.workspace.name },
    message: "GatherGate HMAC-SHA256 webhook verification test.",
  });
  const webhookSecret = resolveWebhookSecret(params.workspace, params.masterKey);
  const headers = buildSignedHeaders(webhookSecret, "webhook.test", body);
  return postWebhookRequest({
    url,
    headers,
    body,
    multiTenant: Boolean(params.multiTenant),
    resolvedAddress: resolved.resolvedAddress,
    family: resolved.family,
    fetchImpl: params.fetchImpl,
  });
}
