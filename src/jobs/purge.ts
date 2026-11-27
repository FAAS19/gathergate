import type { StorageAdapter } from "../adapters/storage.js";
import type { Store } from "../db/queries.js";
import type { LookupAllFn } from "../security/ssrf.js";
import {
  attemptWebhookDelivery,
  buildWebhookEventPayload,
  MAX_WEBHOOK_ATTEMPTS,
} from "./webhook.js";

export async function runPurgeSweep(params: {
  store: Store;
  storage: StorageAdapter;
  nowIso?: string;
  masterKey?: Buffer;
  baseUrl?: string;
  multiTenant?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
}): Promise<{ requestsPurged: number; filesDeleted: number }> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const due = params.store.listPurgeDueRequests(nowIso);
  let requestsPurged = 0;
  let filesDeleted = 0;

  for (const req of due) {
    try {
      const uploads = params.store.listUploadsForRequest(req.id);
      let reqFilesDeleted = 0;
      for (const u of uploads) {
        await params.storage.delete(u.storage_key);
        params.store.markUploadPurged(u.id, nowIso);
        filesDeleted += 1;
        reqFilesDeleted += 1;
      }

      const workspace = params.masterKey ? params.store.getWorkspaceById(req.workspace_id) : undefined;
      const targetUrl = workspace?.webhook_url?.trim() || "";
      const purgedWebhook =
        params.masterKey && workspace && targetUrl
          ? {
              workspaceId: workspace.id,
              targetUrl,
              payloadJson: buildWebhookEventPayload({
                store: params.store,
                workspace,
                request: req,
                event: "request.purged",
                filesDeleted: reqFilesDeleted,
                masterKey: params.masterKey,
                baseUrl: params.baseUrl ?? "",
                nowIso,
              }),
              maxAttempts: MAX_WEBHOOK_ATTEMPTS,
            }
          : null;

      // Atomically shred prior PII/deliveries, mark purged, and enqueue metadata-only request.purged.
      const { finalized, delivery } = params.store.markRequestPurged(req.id, nowIso, purgedWebhook);
      if (!finalized) continue;
      requestsPurged += 1;

      if (delivery && params.masterKey && workspace) {
        await attemptWebhookDelivery({
          store: params.store,
          delivery,
          masterKey: params.masterKey,
          multiTenant: params.multiTenant,
          fetchImpl: params.fetchImpl,
          lookupImpl: params.lookupImpl,
          nowMs,
          workspaceOverride: workspace,
        });
      }
    } catch (err) {
      console.error(`[GatherGate Cron] purge failed for request ${req.id}:`, err);
    }
  }

  return { requestsPurged, filesDeleted };
}
