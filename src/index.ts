#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createEmailAdapter } from "./adapters/email.js";
import { createStorageAdapter } from "./adapters/storage.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { runReminderSweep } from "./jobs/chaser.js";
import { runPurgeSweep } from "./jobs/purge.js";
import { runOverdueSweep, runWebhookRetrySweep } from "./jobs/webhook.js";

const config = loadConfig();
if (config.masterKeySource === "file") {
  console.warn(
    `[GatherGate] MASTER_KEY not set in environment; using auto-generated key at ${config.masterKeyFilePath}. Move MASTER_KEY to an environment variable before production use.`
  );
}
const db = openDatabase(config.dbPath);
const storage = createStorageAdapter(config);
const email = createEmailAdapter(config);

const { app, store, inFlightReminders } = createApp({ config, db, storage, email });

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
      let overdue = 0;
      let purged = { requestsPurged: 0, filesDeleted: 0 };
      let webhooks = { processed: 0, delivered: 0, retrying: 0, deadLetter: 0 };
      try {
        sent = await runReminderSweep({
          store,
          email,
          baseUrl: config.baseUrl,
          masterKey: config.masterKey,
          config,
          saveToOutbox: config.emailBackend === "console",
          inFlightReminders,
        });
      } catch (err) {
        console.error("[GatherGate Cron] reminder sweep failed:", err);
      }
      try {
        overdue = await runOverdueSweep({
          store,
          masterKey: config.masterKey,
          baseUrl: config.baseUrl,
          multiTenant: config.multiTenant,
        });
      } catch (err) {
        console.error("[GatherGate Cron] overdue sweep failed:", err);
      }
      try {
        purged = await runPurgeSweep({
          store,
          storage,
          masterKey: config.masterKey,
          baseUrl: config.baseUrl,
          multiTenant: config.multiTenant,
        });
      } catch (err) {
        console.error("[GatherGate Cron] purge sweep failed:", err);
      }
      try {
        webhooks = await runWebhookRetrySweep({
          store,
          masterKey: config.masterKey,
          multiTenant: config.multiTenant,
        });
      } catch (err) {
        console.error("[GatherGate Cron] webhook retry sweep failed:", err);
      }
      if (sent > 0 || overdue > 0 || purged.requestsPurged > 0 || webhooks.processed > 0) {
        console.log(
          `[GatherGate Cron] reminders_sent=${sent} overdue=${overdue} requests_purged=${purged.requestsPurged} files_deleted=${purged.filesDeleted} webhook_retries=${webhooks.processed}`
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
