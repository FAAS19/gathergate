import { serve } from "@hono/node-server";
import { createEmailAdapter } from "./adapters/email.js";
import { createStorageAdapter } from "./adapters/storage.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { runReminderSweep } from "./jobs/chaser.js";
import { runPurgeSweep } from "./jobs/purge.js";
import { runOverdueSweep, runWebhookRetrySweep } from "./jobs/webhook.js";

export interface StartServerOverrides {
  port?: string;
  host?: string;
  dataDir?: string;
}

function formatHostForUrl(address: string): string {
  const clean = address.replace(/^\[|\]$/g, "");
  return clean.includes(":") ? `[${clean}]` : clean;
}

export function startServer(overrides?: StartServerOverrides): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (overrides?.port !== undefined) env.PORT = overrides.port;
  if (overrides?.host !== undefined) env.HOST = overrides.host;
  if (overrides?.dataDir !== undefined) env.DATA_DIR = overrides.dataDir;

  const hasExplicitPublicBase = Boolean(
    env.BASE_URL?.trim() ||
      env.RENDER_EXTERNAL_URL?.trim() ||
      env.RAILWAY_PUBLIC_DOMAIN?.trim() ||
      env.FLY_APP_NAME?.trim()
  );

  const config = loadConfig(env);
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
      if (!hasExplicitPublicBase && config.port === 0 && info.port > 0) {
        const displayHost =
          config.host === "0.0.0.0" || config.host === "::" || config.host === "[::]"
            ? "localhost"
            : formatHostForUrl(config.host);
        config.baseUrl = `http://${displayHost}:${info.port}`;
      }
      const listenHost = formatHostForUrl(info.address);
      console.log(
        `GatherGate listening on http://${listenHost}:${info.port} (base: ${config.baseUrl}, data: ${config.dataDir}, storage: ${config.storageBackend}, email: ${config.emailBackend})`
      );
    }
  );

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[GatherGate] Port ${config.port} on ${config.host} is already in use. Stop the conflicting process or pass --port <port>.`
      );
    } else if (err.code === "EACCES") {
      console.error(
        `[GatherGate] Permission denied binding to ${config.host}:${config.port}. Choose a port >= 1024 or check host permissions.`
      );
    } else {
      console.error(`[GatherGate] Server failed to start: ${err.message}`);
    }
    try {
      db.close();
    } catch {
      // Ignore close error on failed boot.
    }
    process.exit(1);
  });

  let cronTimer: NodeJS.Timeout | undefined;
  let cronPromise: Promise<void> | null = null;
  if (config.cronIntervalMinutes > 0) {
    const runJobs = () => {
      if (cronPromise) return;
      cronPromise = (async () => {
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
      })().finally(() => {
        cronPromise = null;
      });
    };
    cronTimer = setInterval(runJobs, Math.min(config.cronIntervalMinutes * 60_000, 2_147_483_647));
    cronTimer.unref();
  }

  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (shuttingDown) {
        process.exit(1);
        return;
      }
      shuttingDown = true;
      if (cronTimer) clearInterval(cronTimer);

      // Keep one overall shutdown deadline active across both HTTP draining and cron completion.
      const shutdownDeadline = setTimeout(() => {
        if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        try {
          db.close();
        } catch {
          // Ignore close errors at forced shutdown deadline.
        }
        process.exit(1);
      }, 15_000);
      shutdownDeadline.unref();

      const connForceTimer = setTimeout(() => {
        if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      }, 10_000);
      connForceTimer.unref();

      server.close(async () => {
        clearTimeout(connForceTimer);
        if (cronPromise) {
          await cronPromise.catch(() => {});
        }
        clearTimeout(shutdownDeadline);
        try {
          db.close();
        } catch {
          // Ignore already-closed DB on shutdown.
        }
        process.exit(0);
      });
      if ("closeIdleConnections" in server && typeof server.closeIdleConnections === "function") {
        server.closeIdleConnections();
      }
    });
  }
}
