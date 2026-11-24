import type { StorageAdapter } from "../adapters/storage.js";
import type { Store } from "../db/queries.js";

export async function runPurgeSweep(params: {
  store: Store;
  storage: StorageAdapter;
  nowIso?: string;
}): Promise<{ requestsPurged: number; filesDeleted: number }> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const due = params.store.listPurgeDueRequests(nowIso);
  let filesDeleted = 0;

  for (const req of due) {
    const uploads = params.store.listUploadsForRequest(req.id);
    for (const u of uploads) {
      await params.storage.delete(u.storage_key);
      filesDeleted += 1;
    }
    params.store.markRequestPurged(req.id, nowIso);
  }

  return { requestsPurged: due.length, filesDeleted };
}
