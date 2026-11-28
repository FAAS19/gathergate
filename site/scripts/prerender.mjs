import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const siteRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(siteRoot, "dist");
const ssrDir = path.join(siteRoot, "dist-ssr");
const indexPath = path.join(distDir, "index.html");
const headersPath = path.join(siteRoot, "public", "_headers");

if (!fs.existsSync(indexPath)) {
  throw new Error(`Missing ${indexPath}. Run vite build before prerender.`);
}

await build({
  configFile: path.join(siteRoot, "vite.config.ts"),
  logLevel: "silent",
  build: {
    ssr: path.join(siteRoot, "src", "entry-server.tsx"),
    outDir: ssrDir,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: "esm",
      },
    },
  },
});

try {
  const entryPath = path.join(ssrDir, "entry-server.js");
  const { render } = await import(pathToFileURL(entryPath).href);
  let appHtml = render();

  // Vite SSR resolves base "./" to root-relative "/assets/"; rewrite to "./assets/" so subpath hosting (/gathergate/) works.
  appHtml = appHtml.replace(/(["'\s,])\/assets\//g, "$1./assets/");

  // Strip React 19's leading <link rel="preload" .../> hints from root markup so we hoist one deduplicated LCP preload into <head>.
  appHtml = appHtml.replace(/^(?:<link\b[^>]*rel="preload"[^>]*\/?>)+/i, "");

  // Verify every ./assets/ reference emitted by SSR matches a real client asset.
  const htmlAssetMatches = [...appHtml.matchAll(/\.\/assets\/[^\s"'`,)>]+/g)];
  if (htmlAssetMatches.length === 0) {
    throw new Error("Expected SSR markup to reference built ./assets/ files");
  }
  for (const [relUrl] of htmlAssetMatches) {
    const abs = path.join(distDir, relUrl.slice(2));
    if (!fs.existsSync(abs)) {
      throw new Error(`SSR referenced missing client asset: ${relUrl}`);
    }
  }

  let html = fs.readFileSync(indexPath, "utf8");
  const rootMarker = '<div id="root"></div>';
  if (!html.includes(rootMarker)) {
    throw new Error(`Expected ${rootMarker} in ${indexPath}`);
  }
  html = html.replace(rootMarker, () => `<div id="root">${appHtml}</div>`);

  // Extract Hero LCP image attributes and hoist one preload before the inlined <style> block.
  const lcpImgMatch = appHtml.match(/<img\b[^>]*fetchpriority="high"[^>]*>/i);
  if (!lcpImgMatch) {
    throw new Error('Expected Hero LCP <img> with fetchpriority="high" in SSR markup');
  }
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]+)"`, "i"));
    return m ? m[1] : null;
  };
  const lcpSrcSet = attr(lcpImgMatch[0], "srcset");
  const lcpSizes = attr(lcpImgMatch[0], "sizes");
  if (!lcpSrcSet || !lcpSizes) {
    throw new Error("Hero LCP <img> must define srcset and sizes for preload");
  }
  const preloadTag = `<link rel="preload" as="image" imagesrcset="${lcpSrcSet}" imagesizes="${lcpSizes}" fetchpriority="high" />`;

  // Inline the built stylesheet to remove the render-blocking CSS RTT.
  const cssLinkRe =
    /<link\s+[^>]*rel="stylesheet"[^>]*href="(\.\/assets\/[^"]+\.css)"[^>]*>\s*/;
  const cssMatch = html.match(cssLinkRe);
  if (!cssMatch) {
    throw new Error(`Expected built stylesheet <link> in ${indexPath}`);
  }
  const cssRelPath = cssMatch[1].slice(2);
  const cssAbsPath = path.join(distDir, cssRelPath);
  const rawCss = fs.readFileSync(cssAbsPath, "utf8");
  if (/<\/style\b/i.test(rawCss)) {
    throw new Error(`Refusing to inline CSS containing </style> from ${cssRelPath}`);
  }
  const inlinedCss = rawCss.replace(
    /url\((['"]?)\.\/([^)'"]+)\1\)/g,
    "url($1./assets/$2$1)"
  );
  for (const match of inlinedCss.matchAll(/url\((['"]?)\.\/assets\/([^)'"]+)\1\)/g)) {
    const assetFile = path.join(distDir, "assets", match[2]);
    if (!fs.existsSync(assetFile)) {
      throw new Error(`Inlined CSS referenced missing font/asset: ./assets/${match[2]}`);
    }
  }
  html = html.replace(cssLinkRe, () => `${preloadTag}\n    <style>${inlinedCss}</style>\n  `);
  fs.rmSync(cssAbsPath, { force: true });

  // Fail closed if any root-relative /assets/ URL remains anywhere in the final document.
  if (/(["'\s,(])\/assets\//.test(html)) {
    throw new Error("Prerendered site/dist/index.html still contains a root-relative /assets/ URL");
  }

  // Verify every inline <script> hash is allowlisted in the /* rule's script-src CSP directive.
  const headersContent = fs.readFileSync(headersPath, "utf8");
  const rootRuleMatch = headersContent.match(/^\/\*\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/);
  const rootCspMatch = rootRuleMatch?.[1].match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  const scriptSrcMatch = rootCspMatch?.[1].match(/\bscript-src\s+([^;]+)/);
  if (!scriptSrcMatch) {
    throw new Error("Missing /* Content-Security-Policy script-src directive in site/public/_headers");
  }
  const inlineScripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter(
    (m) => !/\bsrc\s*=/i.test(m[1] ?? "") && m[2].length > 0
  );
  for (const [, , scriptBody] of inlineScripts) {
    const hash = crypto.createHash("sha256").update(scriptBody, "utf8").digest("base64");
    const token = `'sha256-${hash}'`;
    if (!scriptSrcMatch[1].includes(token)) {
      throw new Error(
        `Inline <script> CSP hash ${token} missing from /* script-src in site/public/_headers`
      );
    }
  }

  fs.writeFileSync(indexPath, html, "utf8");
  console.log(
    `Prerendered site/dist/index.html (${Buffer.byteLength(html, "utf8").toLocaleString()} B, CSS inlined: ${Buffer.byteLength(inlinedCss, "utf8").toLocaleString()} B)`
  );
} finally {
  fs.rmSync(ssrDir, { recursive: true, force: true });
}
