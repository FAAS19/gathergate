import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const sourceDir = path.join(projectRoot, "site", "dist");
if (!fs.existsSync(path.join(sourceDir, "index.html"))) {
  throw new Error(`Missing built site at ${sourceDir}. Run npm run build:pages first.`);
}

const outRoot = path.join(projectRoot, ".cloudflare", "output", "v0");
const workerDir = path.join(outRoot, "workers", "default");
const assetsDir = path.join(workerDir, "assets");

fs.rmSync(path.join(projectRoot, ".cloudflare"), { recursive: true, force: true });
fs.mkdirSync(assetsDir, { recursive: true });

fs.writeFileSync(
  path.join(outRoot, "config.json"),
  JSON.stringify({ buildContext: { isPreview: false } }, null, 2) + "\n"
);

fs.writeFileSync(
  path.join(workerDir, "worker.config.json"),
  JSON.stringify(
    {
      name: "gathergate",
      compatibilityDate: "2026-11-27",
      domains: ["gathergate.app"],
      workersDev: false,
      previewUrls: false,
      assets: {
        htmlHandling: "auto-trailing-slash",
      },
    },
    null,
    2
  ) + "\n"
);

fs.cpSync(sourceDir, assetsDir, { recursive: true, dereference: true });
console.log(`Prepared Cloudflare Build Output at ${outRoot}`);
