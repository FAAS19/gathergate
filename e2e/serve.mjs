// Boots the compiled server against a throwaway data directory for Playwright.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, ".e2e-data");
fs.rmSync(dataDir, { recursive: true, force: true });

Object.assign(process.env, {
  NODE_ENV: "test",
  PORT: process.env.E2E_PORT || "3091",
  HOST: "127.0.0.1",
  BASE_URL: `http://127.0.0.1:${process.env.E2E_PORT || "3091"}`,
  DATA_DIR: dataDir,
  MASTER_KEY: "a".repeat(64),
  EMAIL_BACKEND: "console",
  STORAGE_BACKEND: "local",
  CRON_INTERVAL_MINUTES: "0",
});

await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
