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
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
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

    if (!pathname.startsWith(PREFIX)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const rel = pathname.slice(PREFIX.length);
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

    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(target).pipe(res);
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

  // Wait for visible images on initial render to finish loading cleanly.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll("img"));
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

  const llmsRes = await page.request.get(`${baseUrl}/gathergate/llms.txt`);
  expect(llmsRes.status()).toBe(200);
  expect(llmsRes.headers()["content-type"]).toContain("text/plain");
  const llmsBody = await llmsRes.text();
  expect(llmsBody).toContain("GET http://127.0.0.1:3080/healthz");
  expect(llmsBody).toContain("MASTER_KEY");

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
