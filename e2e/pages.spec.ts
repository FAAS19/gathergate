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

  const dockerRunTab = page
    .getByRole("tab", { name: /docker run/i })
    .or(page.getByRole("button", { name: /docker run/i }))
    .first();
  const dockerComposeTab = page
    .getByRole("tab", { name: /docker compose/i })
    .or(page.getByRole("button", { name: /docker compose/i }))
    .first();

  await dockerRunTab.click();
  await expect(page.locator("pre, code").filter({ hasText: /docker run/i }).first()).toBeVisible();
  await dockerComposeTab.click();
  await expect(page.locator("pre, code").filter({ hasText: /docker compose/i }).first()).toBeVisible();

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

  // 4. Client portal OTP gate + accessibility audit on demo-tax
  await page.goto(`${baseUrl}/gathergate/demo/#/c/demo-tax`);
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await page.getByRole("button", { name: "Email me a code" }).click();
  const otpInput = page.getByLabel("6-digit verification code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill("482910");
  await expect(page.getByRole("heading", { name: "FY26 Individual Tax Return Pack" })).toBeVisible();

  await expectAccessible(page, testInfo, "pages-demo-portal");
  expect(issues).toEqual([]);
});
