import type { StorageAdapter } from "../adapters/storage.js";
import type { Store } from "../db/queries.js";

export async function runPurgeSweep(params: {
  store: Store;
  storage: StorageAdapter;
  nowIso?: string;
}): Promise<{ requestsPurged: number; filesDeleted: number }> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const due = params.store.listPurgeDueRequests(nowIso);
  let requestsPurged = 0;
  let filesDeleted = 0;

  for (const req of due) {
    try {
      const uploads = params.store.listUploadsForRequest(req.id);
      for (const u of uploads) {
        await params.storage.delete(u.storage_key);
        params.store.markUploadPurged(u.id, nowIso);
        filesDeleted += 1;
      }
      params.store.markRequestPurged(req.id, nowIso);
      requestsPurged += 1;
    } catch (err) {
      console.error(`[GatherGate Cron] purge failed for request ${req.id}:`, err);
    }
  }

  return { requestsPurged, filesDeleted };
}
