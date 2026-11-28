import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, PNG, trackErrors } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIST = path.join(ROOT, "site", "dist");
const PREFIX = "/gathergate/";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".pf_meta": "application/octet-stream",
  ".pf_index": "application/octet-stream",
  ".pf_fragment": "application/octet-stream",
  ".pagefind": "application/octet-stream",
};

let server: http.Server;
let baseUrl = "";

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(SITE_DIST, "index.html"))) {
    throw new Error(`Missing built GitHub Pages bundle at ${SITE_DIST}. Run npm run build:pages first.`);
  }

  server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === "/gathergate") {
      res.writeHead(302, { Location: `${PREFIX}${reqUrl.search}` });
      res.end();
      return;
    }

    if (pathname === "/docs") {
      res.writeHead(302, { Location: `/docs/${reqUrl.search}` });
      res.end();
      return;
    }

    let rel: string | null = null;
    if (pathname.startsWith(PREFIX)) {
      rel = pathname.slice(PREFIX.length);
    } else if (
      pathname.startsWith("/docs/") ||
      pathname.startsWith("/media/") ||
      pathname === "/favicon.svg"
    ) {
      rel = pathname.slice(1);
    }
    if (rel === null) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const candidate = path.resolve(SITE_DIST, rel);
    if (candidate !== SITE_DIST && !candidate.startsWith(SITE_DIST + path.sep)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    let target = candidate;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      if (!pathname.endsWith("/")) {
        res.writeHead(302, { Location: `${pathname}/${reqUrl.search}` });
        res.end();
        return;
      }
      target = path.join(target, "index.html");
    } else if (pathname.endsWith("/")) {
      target = path.join(candidate, "index.html");
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const stat = fs.statSync(target);
    const ext = path.extname(target).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const rangeHeader = req.headers.range;

    const pipeFile = (opts?: { start: number; end: number }) => {
      const stream = opts ? fs.createReadStream(target, opts) : fs.createReadStream(target);
      res.on("close", () => stream.destroy());
      stream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end();
      });
      stream.pipe(res);
    };

    if (rangeHeader && rangeHeader.trim().startsWith("bytes=") && !rangeHeader.includes(",")) {
      if (stat.size === 0) {
        res.writeHead(416, { "Content-Range": "bytes */0" });
        res.end();
        return;
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      const end = match[2] && match[1] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      pipeFile({ start, end });
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(stat.size),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    pipeFile();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function trackPageIssues(page: Page) {
  const issues = trackErrors(page);
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith(`${baseUrl}/`) && !url.startsWith("blob:") && !url.startsWith("data:")) {
      issues.push(`external request: ${url}`);
    }
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      issues.push(`http ${res.status()}: ${res.url()}`);
    }
  });
  return issues;
}

test("showcase site renders cleanly under /gathergate/ subpath with 0 broken assets and WCAG 2.2 AA compliance", async ({
  page,
}, testInfo) => {
  const issues = trackPageIssues(page);

  await page.goto(`${baseUrl}/gathergate/`);

  const tryDemoCta = page
    .getByRole("link", { name: /Try live demo/i })
    .or(page.getByRole("button", { name: /Try live demo/i }))
    .first();
  await expect(tryDemoCta).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 1024) {
    const box = await tryDemoCta.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }

  // Wait for eager above-the-fold images on initial render to finish loading cleanly.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll("img")).filter(
          (img) => img.loading !== "lazy"
        );
        return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
      })
    )
    .toBe(true);

  for (const label of ["Client portal", "Mobile intake", "Operator review"]) {
    const tab = page
      .getByRole("tab", { name: new RegExp(label, "i") })
      .or(page.getByRole("button", { name: new RegExp(label, "i") }))
      .first();
    await tab.click();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const visibleImgs = Array.from(document.querySelectorAll("img")).filter((img) => {
            const style = window.getComputedStyle(img);
            const rect = img.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
          return visibleImgs.length > 0 && visibleImgs.every((img) => img.complete && img.naturalWidth > 0);
        })
      )
      .toBe(true);
  }

  const selfHost = page.locator("#self-host");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const npxTab = selfHost.getByRole("tab", { name: /^npx$/i });
  await expect(npxTab).toHaveAttribute("aria-selected", "true");

  const deployTabs = [
    {
      name: /^npx$/i,
      text: /npx gathergate/,
      copied: /^npx gathergate$/,
    },
    {
      name: /docker run/i,
      text: /docker run -d/,
      copied: /^docker run -d \\\n\s+--name gathergate \\\n\s+-p 127\.0\.0\.1:3080:3080 \\\n\s+-v gathergate_data:\/data \\\n\s+ghcr\.io\/faas19\/gathergate:latest$/,
    },
    {
      name: /docker compose/i,
      text: /docker compose up -d --build/,
      copied: /^git clone https:\/\/github\.com\/FAAS19\/gathergate\.git \\\n\s+&& cd gathergate \\\n\s+&& docker compose up -d --build$/,
      alwaysFit: false,
    },
    {
      name: /AI agent/i,
      text: /gathergate\.tensorforge\.dev\/llms\.txt/,
      copied: /^Read https:\/\/gathergate\.tensorforge\.dev\/llms\.txt and help me install GatherGate\.\nCheck whether Docker or Node\.js >= 22\.13 is installed/,
      alwaysFit: true,
    },
  ];

  for (const deployTab of deployTabs) {
    await selfHost.getByRole("tab", { name: deployTab.name }).click();
    const pre = selfHost.locator("pre");
    await expect(pre).toBeVisible();
    await expect(pre).toContainText(deployTab.text);

    const noTabClip = await selfHost
      .locator('[role="tablist"]')
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.closest(".overflow-hidden")!.scrollLeft === 0);
    expect(noTabClip).toBe(true);

    if (deployTab.alwaysFit || (viewport && viewport.width >= 1024)) {
      const fitsWithoutScroll = await pre.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fitsWithoutScroll).toBe(true);
    }

    await selfHost.getByRole("button", { name: /^Copy$/i }).click();
    await expect(selfHost.getByRole("button", { name: /^Copied$/i })).toBeVisible();
    const clipboardText = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    expect(clipboardText).toMatch(deployTab.copied);
    expect(clipboardText.startsWith("$ ")).toBe(false);
  }

  // Verify compact #watch walkthrough banner card, Light + Dark WCAG 2.2 AA, and native <dialog> focus trap.
  const watchSection = page.locator("#watch");
  await expect(watchSection.getByRole("heading", { name: "See GatherGate in action", level: 2 })).toBeVisible();
  const watchTrigger = watchSection.getByRole("button", { name: "Watch demo" });
  await expect(watchTrigger).toBeVisible();

  await expectAccessible(page, testInfo, "pages-showcase-light");
  const themeToggle = page.getByRole("button", { name: /Switch to (dark|light) mode/i });
  await themeToggle.click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const heroImg = document.querySelector<HTMLImageElement>('img[fetchpriority="high"]');
        return Boolean(
          heroImg &&
            heroImg.currentSrc.includes("operator-dashboard-dark-") &&
            heroImg.complete &&
            heroImg.naturalWidth > 0
        );
      })
    )
    .toBe(true);
  await expectAccessible(page, testInfo, "pages-showcase-dark");
  await themeToggle.click();

  await watchTrigger.click();
  const videoDialog = page.getByRole("dialog", { name: "GatherGate product demo" });
  await expect(videoDialog).toBeVisible();
  const showcaseVideo = videoDialog.locator("video");
  await expect(showcaseVideo).toBeVisible();
  await expect(showcaseVideo.locator('source[type="video/mp4"]')).toHaveAttribute(
    "src",
    "./media/gathergate-launch-v2-web.mp4"
  );
  await expect(showcaseVideo.locator('track[kind="captions"]')).toHaveAttribute(
    "src",
    "./media/gathergate-launch-v2.vtt"
  );
  await expectAccessible(page, testInfo, "pages-showcase-video-modal");

  // Confirm Shift+Tab and Tab never escape the native top-layer <dialog> into background page content.
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(videoDialog).toHaveCount(0);
  await expect(watchTrigger).toBeFocused();

  await watchTrigger.click();
  await expect(videoDialog).toBeVisible();
  await videoDialog.getByRole("button", { name: "Close video" }).click();
  await expect(videoDialog).toHaveCount(0);

  const posterRes = await page.request.get(`${baseUrl}/gathergate/media/gathergate-launch-v2-poster.webp`);
  expect(posterRes.status()).toBe(200);
  expect(posterRes.headers()["content-type"]).toContain("image/webp");

  const mp4RangeRes = await page.request.get(`${baseUrl}/gathergate/media/gathergate-launch-v2-web.mp4`, {
    headers: { Range: "bytes=0-1023" },
  });
  expect(mp4RangeRes.status()).toBe(206);
  expect(mp4RangeRes.headers()["content-type"]).toContain("video/mp4");

  const vttRes = await page.request.get(`${baseUrl}/gathergate/media/gathergate-launch-v2.vtt`);
  expect(vttRes.status()).toBe(200);
  expect(vttRes.headers()["content-type"]).toContain("text/vtt");
  const vttBody = await vttRes.text();
  expect(vttBody).toContain("WEBVTT");
  expect(vttBody).toContain("GatherGate");
  expect(vttBody).not.toContain("Gather Gate");

  const llmsRes = await page.request.get(`${baseUrl}/gathergate/llms.txt`);
  expect(llmsRes.status()).toBe(200);
  expect(llmsRes.headers()["content-type"]).toContain("text/plain");
  const llmsBody = await llmsRes.text();
  expect(llmsBody).toContain("GET http://127.0.0.1:3080/healthz");
  expect(llmsBody).toContain("MASTER_KEY");
  expect(llmsBody).toContain("https://gathergate.tensorforge.dev/#watch");

  await expectAccessible(page, testInfo, "pages-showcase");
  expect(issues).toEqual([]);
});

test("interactive VITE_DEMO=1 browser demo works end to end under /gathergate/demo/", async ({
  page,
}, testInfo) => {
  const issues: string[] = [];
  let expectInvalidAbn400 = false;

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const loc = msg.location()?.url ?? "";
      if (expectInvalidAbn400 && msg.text().includes("400") && (!loc || loc.includes("/api/client/demo-bas/items/"))) {
        return;
      }
      issues.push(`console: ${msg.text()}`);
    }
  });
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith(`${baseUrl}/`) && !url.startsWith("blob:") && !url.startsWith("data:")) {
      issues.push(`external request: ${url}`);
    }
  });
  page.on("pageerror", (err) => issues.push(`pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400) {
      if (expectInvalidAbn400 && res.status() === 400 && res.url().includes("/api/client/demo-bas/items/")) {
        return;
      }
      issues.push(`http ${res.status()}: ${res.url()}`);
    }
  });

  // 1. Entry from showcase page into HashRouter operator console
  await page.goto(`${baseUrl}/gathergate/`);
  const tryDemoCta = page
    .getByRole("link", { name: /Try live demo/i })
    .or(page.getByRole("button", { name: /Try live demo/i }))
    .first();
  await tryDemoCta.click();

  await expect(page).toHaveURL(/\/gathergate\/demo\/(#\/)?$/);
  await expect(page.getByText(/Interactive browser demo \(no server\)/i)).toBeVisible();
  await expect(page.getByText("FY26 Individual Tax Return Pack")).toBeVisible();
  await expect(page.getByText("Q3 BAS & Supplier Pack")).toBeVisible();
  await expect(page.getByText("Allied Health New Patient Intake")).toBeVisible();

  // 2. Open tax return pack, inspect inline preview text in ReviewSheet, approve an item
  await page.getByRole("link", { name: "FY26 Individual Tax Return Pack" }).click();
  await expect(page.getByRole("heading", { name: "FY26 Individual Tax Return Pack" })).toBeVisible();

  const receiptsCard = page.locator("[data-item-id]").filter({ hasText: "Work-Related Expense" }).first();
  await receiptsCard.getByRole("button", { name: "Preview" }).first().click();

  const reviewDialog = page.getByRole("dialog");
  await expect(reviewDialog).toBeVisible();
  await expect(reviewDialog.locator("pre")).toBeVisible();
  await expect(reviewDialog.locator("pre")).not.toBeEmpty();
  await reviewDialog.getByRole("button", { name: /Approve/i }).click();
  await page.keyboard.press("Escape");
  await expect(receiptsCard.getByText("Locked")).toBeVisible();

  // 3. Client portal validation and upload on demo-bas
  await page.goto(`${baseUrl}/gathergate/demo/#/c/demo-bas`);
  await expect(page.getByRole("heading", { name: "Q3 BAS & Supplier Pack" })).toBeVisible();

  const abnCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: /Australian Business Number/i }),
  });
  const abnInput = abnCard.getByRole("textbox");

  expectInvalidAbn400 = true;
  await abnInput.fill("51 824 753 557");
  await abnInput.blur();
  await expect(abnCard.getByText(/Invalid ABN checksum|mod-89/i)).toBeVisible();
  await expect(abnInput).toHaveAttribute("aria-invalid", "true");
  expectInvalidAbn400 = false;

  await abnInput.fill("51 824 753 556");
  await abnInput.blur();
  await expect(abnCard.getByText(/Invalid ABN checksum|mod-89|Could not save/i)).toHaveCount(0);
  await expect(abnInput).not.toHaveAttribute("aria-invalid", "true");
  await expect(abnCard.locator('[title="Done"]')).toBeVisible();

  const invoicesCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: /Missing Supplier Tax Invoices/i }),
  });
  await invoicesCard.locator('input[type="file"]').first().setInputFiles({
    name: "supplier-receipt.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(invoicesCard.getByText("supplier-receipt.png")).toBeVisible();

  await invoicesCard.locator('input[type="file"]').first().setInputFiles({
    name: "evil.png",
    mimeType: "image/png",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
  });
  await expect(invoicesCard.getByRole("alert")).toContainText(/failed file-type verification/i);
  await expect(
    invoicesCard.getByRole("list", { name: "Uploaded files" }).getByText("evil.png")
  ).toHaveCount(0);

  // 4. Client portal OTP gate + accessibility audit on demo-tax
  await page.goto(`${baseUrl}/gathergate/demo/#/c/demo-tax`);
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await page.getByRole("button", { name: "Email me a code" }).click();
  const otpInput = page.getByLabel("6-digit verification code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill("482910");
  await expect(page.getByRole("heading", { name: "FY26 Individual Tax Return Pack" })).toBeVisible();

  await expectAccessible(page, testInfo, "pages-demo-portal");

  // 5. Local outbox sandboxed iframe, webhook simulation (0 outbound calls), and Reset demo
  await page.getByRole("navigation", { name: "Demo navigation" }).getByRole("link", { name: "Local outbox" }).click();
  await expect(page.getByRole("heading", { name: "Local Email Outbox" })).toBeVisible();
  await expect(page.getByText("482910 is your verification code").first()).toBeVisible();
  await expect(page.locator('iframe[sandbox=""]')).toHaveAttribute("sandbox", "");

  await page.goto(`${baseUrl}/gathergate/demo/#/settings?section=webhooks`);
  await page.getByLabel("Webhook Endpoint URL").fill("https://example.invalid/hook");
  await page.getByRole("button", { name: "Save webhook settings" }).click();
  await page.getByRole("button", { name: "Send test event" }).click();
  await expect(page.getByText(/Demo mode: webhook test simulated locally/i)).toBeVisible();

  await page.getByRole("navigation", { name: "Demo navigation" }).getByRole("button", { name: "Reset demo" }).click();
  await page.goto(`${baseUrl}/gathergate/demo/#/c/demo-tax`);
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();

  // The outbox preview sandbox refusing script execution confirms sandbox="" protection is active.
  expect(
    issues.filter((e) => !e.includes("frame is sandboxed and the 'allow-scripts' permission is not set"))
  ).toEqual([]);
});

test("Astro Starlight docs render cleanly under /docs/ with search, navigation, and WCAG 2.2 AA compliance", async ({
  page,
}, testInfo) => {
  const issues = trackPageIssues(page);

  await page.goto(`${baseUrl}/docs/`);
  await expect(page.getByRole("heading", { name: "GatherGate Documentation", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Product Walkthrough", level: 2 })).toBeVisible();
  const docsVideo = page.locator("video");
  await expect(docsVideo).toBeVisible();
  await expect(docsVideo.locator('source[type="video/mp4"]')).toHaveAttribute(
    "src",
    "../media/gathergate-launch-v2-web.mp4"
  );
  await expect(docsVideo.locator('track[kind="captions"]')).toHaveAttribute(
    "src",
    "../media/gathergate-launch-v2.vtt"
  );
  await expectAccessible(page, testInfo, "pages-docs-index");

  // Verify Starlight sidebar external links never double-prefix /docs/ or add trailing slash to .txt
  await expect(page.locator("nav a", { hasText: "Full Docs (llms-full.txt)" })).toHaveAttribute(
    "href",
    "https://gathergate.tensorforge.dev/docs/llms-full.txt"
  );
  await expect(page.locator("nav a", { hasText: "Interactive Demo" })).toHaveAttribute(
    "href",
    "https://gathergate.tensorforge.dev/demo/#/"
  );
  await expect(page.locator("nav a", { hasText: "GatherGate Home" })).toHaveAttribute(
    "href",
    "https://gathergate.tensorforge.dev/"
  );

  await page.getByRole("link", { name: /Quickstart/i }).first().click();
  await expect(page).toHaveURL(/\/docs\/getting-started\/quickstart\/$/);
  await expect(page.getByRole("heading", { name: "Quickstart", level: 1 })).toBeVisible();
  await expect(page.locator("pre").first()).toContainText(/npx gathergate/);

  // Verify Pagefind offline search returns results with zero external calls.
  await page.getByRole("button", { name: /Search/i }).first().click();
  const searchInput = page.locator("dialog input[type='text'], .pagefind-ui__search-input").first();
  await expect(searchInput).toBeVisible();
  await searchInput.fill("HMAC");
  await expect(page.locator(".pagefind-ui__result-link").first()).toContainText(/Webhook/i, { timeout: 10_000 });
  await page.keyboard.press("Escape");

  await expectAccessible(page, testInfo, "pages-docs");

  // Verify new agentic MCP guide and 1-click deploy template guide render & pass WCAG 2.2 AA.
  await page.goto(`${baseUrl}/docs/guides/ai-agents/`);
  await expect(page.getByRole("heading", { name: "AI Agents & MCP 2.0", level: 1 })).toBeVisible();
  await expect(page.getByText("POST /mcp").first()).toBeVisible();
  await expectAccessible(page, testInfo, "pages-docs-ai-agents");

  await page.goto(`${baseUrl}/docs/deployment/one-click-templates/`);
  await expect(page.getByRole("heading", { name: "1-Click Self-Hosted Deploy Templates", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Why Not Vercel/i, level: 2 })).toBeVisible();
  await expectAccessible(page, testInfo, "pages-docs-deploy-templates");

  // Verify auto-generated /docs/llms-full.txt and per-page raw .md endpoints for AI agents.
  const fullTxtRes = await page.request.get(`${baseUrl}/docs/llms-full.txt`);
  expect(fullTxtRes.status()).toBe(200);
  expect(fullTxtRes.headers()["content-type"]).toContain("text/plain");
  const fullTxt = await fullTxtRes.text();
  expect(fullTxt).toContain("# GatherGate Documentation (Full Agent Reference)");
  expect(fullTxt).toContain("POST /mcp");
  expect(fullTxt).toContain("render.yaml");
  expect(fullTxt).toContain("https://gathergate.tensorforge.dev/#watch");
  expect(fullTxt).not.toContain("<video");
  expect(fullTxt).not.toContain("<figure");
  expect(fullTxt.includes("\u2014")).toBe(false);

  for (const [mdPath, expectedText] of [
    ["/docs/index.md", "# GatherGate Documentation"],
    ["/docs/getting-started/quickstart.md", "npx gathergate"],
    ["/docs/guides/ai-agents.md", "skill://gathergate/SKILL.md"],
    ["/docs/deployment/one-click-templates.md", "ghcr.io/faas19/gathergate:latest"],
    ["/docs/guides/webhooks.md", "X-GatherGate-Delivery"],
  ] as const) {
    const mdRes = await page.request.get(`${baseUrl}${mdPath}`);
    expect(mdRes.status(), `Expected 200 for ${mdPath}`).toBe(200);
    expect(mdRes.headers()["content-type"]).toContain("text/markdown");
    const mdText = await mdRes.text();
    expect(mdText).toContain(expectedText);
    expect(mdText.includes("\u2014")).toBe(false);
    expect(mdText).not.toContain("import {");
    expect(mdText).not.toContain("<video");
    expect(mdText).not.toContain("<figure");
  }

  expect(issues).toEqual([]);
});
