#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createEmailAdapter } from "./adapters/email.js";
import { createStorageAdapter } from "./adapters/storage.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { runReminderSweep } from "./jobs/chaser.js";
import { runPurgeSweep } from "./jobs/purge.js";

const config = loadConfig();
if (config.masterKeySource === "file") {
  console.warn(
    `[GatherGate] MASTER_KEY not set in environment; using auto-generated key at ${config.masterKeyFilePath}. Move MASTER_KEY to an environment variable before production use.`
  );
}
const db = openDatabase(config.dbPath);
const storage = createStorageAdapter(config);
const email = createEmailAdapter(config);

const { app, store } = createApp({ config, db, storage, email });

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(
      `GatherGate listening on http://${info.address}:${info.port} (base: ${config.baseUrl}, storage: ${config.storageBackend}, email: ${config.emailBackend})`
    );
  }
);

let cronTimer: NodeJS.Timeout | undefined;
let cronInFlight = false;
if (config.cronIntervalMinutes > 0) {
  const runJobs = async () => {
    if (cronInFlight) return;
    cronInFlight = true;
    try {
      let sent = 0;
      let purged = { requestsPurged: 0, filesDeleted: 0 };
      try {
        sent = await runReminderSweep({
          store,
          email,
          baseUrl: config.baseUrl,
          masterKey: config.masterKey,
          config,
          saveToOutbox: config.emailBackend === "console",
        });
      } catch (err) {
        console.error("[GatherGate Cron] reminder sweep failed:", err);
      }
      try {
        purged = await runPurgeSweep({ store, storage });
      } catch (err) {
        console.error("[GatherGate Cron] purge sweep failed:", err);
      }
      if (sent > 0 || purged.requestsPurged > 0) {
        console.log(
          `[GatherGate Cron] reminders_sent=${sent} requests_purged=${purged.requestsPurged} files_deleted=${purged.filesDeleted}`
        );
      }
    } finally {
      cronInFlight = false;
    }
  };
  cronTimer = setInterval(runJobs, config.cronIntervalMinutes * 60_000);
  cronTimer.unref();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (cronTimer) clearInterval(cronTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  });
}
