import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const sourceDir = path.join(projectRoot, "site", "dist");
if (!fs.existsSync(path.join(sourceDir, "index.html"))) {
  throw new Error(`Missing built site at ${sourceDir}. Run npm run build:pages first.`);
}

const outRoot = path.join(projectRoot, ".cloudflare", "output", "v0");
const workerDir = path.join(outRoot, "workers", "default");
const bundleDir = path.join(workerDir, "bundle");
const assetsDir = path.join(workerDir, "assets");

fs.rmSync(path.join(projectRoot, ".cloudflare"), { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

const rangeWorkerSource = `// Serves static assets and adds RFC 9110 byte-range (206 Partial Content) support for MP4 walkthrough video.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isMediaMp4 = url.pathname.startsWith("/media/") && url.pathname.endsWith(".mp4");
    if (!isMediaMp4 || (request.method !== "GET" && request.method !== "HEAD")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "HEAD") {
      const headRes = await env.ASSETS.fetch(request);
      const headers = new Headers(headRes.headers);
      headers.set("Accept-Ranges", "bytes");
      return new Response(null, { status: headRes.status, statusText: headRes.statusText, headers });
    }

    const rangeHeader = request.headers.get("range");
    if (!rangeHeader) {
      const fullRes = await env.ASSETS.fetch(request);
      const headers = new Headers(fullRes.headers);
      headers.set("Accept-Ranges", "bytes");
      return new Response(fullRes.body, { status: fullRes.status, statusText: fullRes.statusText, headers });
    }

    const fullRes = await env.ASSETS.fetch(new Request(request.url, { method: "GET" }));
    if (!fullRes.ok) {
      return fullRes;
    }

    const buf = await fullRes.arrayBuffer();
    const total = buf.byteLength;
    const match = rangeHeader.trim().match(/^bytes=(\\d*)-(\\d*)$/i);
    if (!match || (match[1] === "" && match[2] === "")) {
      const headers = new Headers(fullRes.headers);
      headers.set("Accept-Ranges", "bytes");
      return new Response(buf, { status: 200, headers });
    }

    let start;
    let end;
    if (match[1] === "") {
      const suffix = Number.parseInt(match[2], 10);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": \`bytes */\${total}\`, "Accept-Ranges": "bytes" },
        });
      }
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = Number.parseInt(match[1], 10);
      end = match[2] === "" ? total - 1 : Math.min(Number.parseInt(match[2], 10), total - 1);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || end < start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": \`bytes */\${total}\`, "Accept-Ranges": "bytes" },
      });
    }

    const slice = buf.slice(start, end + 1);
    const headers = new Headers(fullRes.headers);
    headers.delete("content-encoding");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Range", \`bytes \${start}-\${end}/\${total}\`);
    headers.set("Content-Length", String(slice.byteLength));
    return new Response(slice, { status: 206, headers });
  },
};
`;

fs.writeFileSync(path.join(bundleDir, "index.mjs"), rangeWorkerSource);

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
      manifest: {
        type: "complete",
        mainModule: "index.mjs",
        modules: {
          "index.mjs": { type: "esm" },
        },
      },
      env: {
        ASSETS: { type: "assets" },
      },
      assets: {
        htmlHandling: "auto-trailing-slash",
        runWorkerFirst: ["/media/*.mp4"],
      },
    },
    null,
    2
  ) + "\n"
);

fs.cpSync(sourceDir, assetsDir, { recursive: true, dereference: true });
console.log(`Prepared Cloudflare Build Output at ${outRoot}`);
