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

    const ifRange = request.headers.get("if-range")?.trim();
    if (ifRange) {
      const etag = fullRes.headers.get("etag")?.trim();
      const lastMod = fullRes.headers.get("last-modified")?.trim();
      const etagMatch = Boolean(
        etag && !ifRange.startsWith("W/") && !etag.startsWith("W/") && ifRange === etag
      );
      const dateMatch = Boolean(lastMod && ifRange === lastMod);
      if (!etagMatch && !dateMatch) {
        const headers = new Headers(fullRes.headers);
        headers.set("Accept-Ranges", "bytes");
        return new Response(fullRes.body, { status: 200, headers });
      }
    }

    const match = rangeHeader.trim().match(/^bytes=(\\d*)-(\\d*)$/i);
    if (!match || (match[1] === "" && match[2] === "")) {
      const headers = new Headers(fullRes.headers);
      headers.set("Accept-Ranges", "bytes");
      return new Response(fullRes.body, { status: 200, headers });
    }

    const parseRange = (total) => {
      let start;
      let end;
      if (match[1] === "") {
        const suffix = Number.parseInt(match[2], 10);
        if (!Number.isFinite(suffix) || suffix <= 0) return null;
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = Number.parseInt(match[1], 10);
        end = match[2] === "" ? total - 1 : Math.min(Number.parseInt(match[2], 10), total - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || end < start) {
        return null;
      }
      return { start, end };
    };

    const contentLengthHeader = fullRes.headers.get("content-length")?.trim();
    const knownTotal =
      contentLengthHeader && /^\\d+$/.test(contentLengthHeader)
        ? Number.parseInt(contentLengthHeader, 10)
        : null;

    if (knownTotal !== null && fullRes.body) {
      const bounds = parseRange(knownTotal);
      if (!bounds) {
        await fullRes.body.cancel().catch(() => {});
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": \`bytes */\${knownTotal}\`, "Accept-Ranges": "bytes" },
        });
      }
      const { start, end } = bounds;
      const reader = fullRes.body.getReader();
      let offset = 0;
      const slicedStream = new ReadableStream({
        async pull(controller) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            const chunkStart = offset;
            const chunkEnd = offset + value.byteLength - 1;
            offset += value.byteLength;
            if (chunkEnd < start) continue;
            const sliceStart = Math.max(0, start - chunkStart);
            const sliceEnd = Math.min(value.byteLength, end - chunkStart + 1);
            if (sliceEnd > sliceStart) {
              controller.enqueue(value.subarray(sliceStart, sliceEnd));
            }
            if (chunkEnd >= end) {
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
            return;
          }
        },
        cancel() {
          return reader.cancel();
        },
      });
      const headers = new Headers(fullRes.headers);
      headers.delete("content-encoding");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Range", \`bytes \${start}-\${end}/\${knownTotal}\`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(slicedStream, { status: 206, headers });
    }

    const buf = await fullRes.arrayBuffer();
    const total = buf.byteLength;
    const bounds = parseRange(total);
    if (!bounds) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": \`bytes */\${total}\`, "Accept-Ranges": "bytes" },
      });
    }
    const { start, end } = bounds;
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
