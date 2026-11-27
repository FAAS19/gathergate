import type { StorageAdapter } from "../adapters/storage.js";
import type { Store } from "../db/queries.js";
import type { LookupAllFn } from "../security/ssrf.js";
import { dispatchWebhookEvent } from "./webhook.js";

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
      params.store.markRequestPurged(req.id, nowIso);
      requestsPurged += 1;

      if (params.masterKey) {
        const workspace = params.store.getWorkspaceById(req.workspace_id);
        if (workspace?.webhook_url?.trim()) {
          await dispatchWebhookEvent({
            store: params.store,
            workspace,
            request: req,
            event: "request.purged",
            filesDeleted: reqFilesDeleted,
            masterKey: params.masterKey,
            baseUrl: params.baseUrl ?? "",
            multiTenant: params.multiTenant,
            fetchImpl: params.fetchImpl,
            lookupImpl: params.lookupImpl,
            nowMs,
          });
        }
      }
    } catch (err) {
      console.error(`[GatherGate Cron] purge failed for request ${req.id}:`, err);
    }
  }

  return { requestsPurged, filesDeleted };
}
