// Captures crisp viewport-framed light-mode screenshots for the GitHub Pages showcase site.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";
import { createEmailAdapter } from "../dist/adapters/email.js";
import { createStorageAdapter } from "../dist/adapters/storage.js";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { openDatabase } from "../dist/db/client.js";

const PORT = Number(process.env.SHOWCASE_PORT || 3093);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOTS_DIR = path.join(ROOT, "site", "public", "screenshots");

const STATEMENT_CSV = [
  "Date,Description,Reference,Debit,Credit,Balance",
  "2026-07-02,OPENING BALANCE B/F,Q3-OPEN,,,48210.45",
  "2026-07-07,DIRECT CREDIT CITY OF MELBOURNE INV-1042,CR-88412,,6840.00,55050.45",
  "2026-07-12,EFTPOS REECE PLUMBING SUPPLIES #219,INV-7731,1485.50,,53564.95",
  "2026-07-18,BPAY ATO BAS PAYMENT Q2,ATO-009241,4120.00,,49444.95",
  "2026-07-25,DIRECT CREDIT HARBOURSIDE STRATA INV-1049,CR-89105,,9450.00,58894.95",
  "2026-08-03,EFTPOS BUNNINGS TRADE ACCOUNT,TR-44018,892.35,,58002.60",
  "2026-08-14,DIRECT CREDIT BAYSIDE COMMERCIAL INV-1055,CR-90214,,7320.00,65322.60",
  "2026-09-02,EFTPOS ORIGIN ENERGY FLEET FUEL,FL-11820,612.50,,64710.10",
  "2026-09-29,BANK SERVICE FEE BUSINESS EVERYDAY,FEE-0926,30.00,,64680.10",
  "2026-09-30,CLOSING BALANCE C/F,Q3-CLOSE,,,64680.10",
].join("\n") + "\n";

const SAMPLE_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

async function apiJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${init?.method || "GET"} ${url} failed (${res.status}): ${await res.text()}`);
  }
  return res;
}

async function waitForSettled(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-showcase-"));

  let db;
  let server;
  let browser;

  try {
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      BASE_URL,
      DATA_DIR: dataDir,
      MASTER_KEY: "a".repeat(64),
      STORAGE_BACKEND: "local",
      EMAIL_BACKEND: "console",
      CRON_INTERVAL_MINUTES: "0",
    });

    db = openDatabase(config.dbPath);
    const storage = createStorageAdapter(config);
    const email = createEmailAdapter(config);
    const { app } = createApp({ config, db, storage, email });

    await new Promise((resolve) => {
      server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve());
    });

    const setupRes = await apiJson(`${BASE_URL}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Harbour Advisory",
        email: "ops@harbouradvisory.com.au",
        password: "showcase-capture-123",
        loadDemo: true,
      }),
    });
    const rawCookie = setupRes.headers.getSetCookie?.()[0] || setupRes.headers.get("set-cookie") || "";
    const sessionCookie = rawCookie.split(";")[0];
    if (!sessionCookie) {
      throw new Error("Missing session cookie from POST /api/setup");
    }

    await apiJson(`${BASE_URL}/api/settings/branding`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        brandColor: "#0F5243",
        supportEmail: "help@harbouradvisory.com.au",
        supportPhone: "+61 3 9000 4120",
        logoDataUrl: null,
      }),
    });

    const listRes = await apiJson(`${BASE_URL}/api/requests`, {
      headers: { cookie: sessionCookie },
    });
    const listData = await listRes.json();
    const basRequest = listData.requests.find((r) => r.title === "Q3 BAS & Supplier Pack");
    if (!basRequest) {
      throw new Error("Seeded Q3 BAS & Supplier Pack request not found");
    }
    const basToken = new URL(basRequest.portal_url).pathname.split("/c/")[1];

    const detailRes = await apiJson(`${BASE_URL}/api/requests/${basRequest.id}`, {
      headers: { cookie: sessionCookie },
    });
    const detailData = await detailRes.json();
    const bankItem = detailData.items.find((i) => i.label.includes("Bank Statements"));
    const supplierItem = detailData.items.find((i) => i.label.includes("Missing Supplier Tax Invoices"));
    if (!bankItem || !supplierItem) {
      throw new Error("Expected BAS checklist items not found");
    }

    const csvForm = new FormData();
    csvForm.append("file", new File([STATEMENT_CSV], "nab-q3-business-statement.csv", { type: "text/csv" }));
    await apiJson(`${BASE_URL}/api/client/${basToken}/items/${bankItem.id}`, {
      method: "POST",
      body: csvForm,
    });

    // Populate a second submitted document item so ReviewSheet displays "Approve & next".
    const invoiceForm = new FormData();
    invoiceForm.append("file", new File([SAMPLE_PDF], "reece-plumbing-invoice-7731.pdf", { type: "application/pdf" }));
    await apiJson(`${BASE_URL}/api/client/${basToken}/items/${supplierItem.id}`, {
      method: "POST",
      body: invoiceForm,
    });

    browser = await chromium.launch();

    // 1. Operator dashboard and ReviewSheet (1440x900 gives full unclipped width beside sidebar)
    const opContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await opContext.addInitScript(() => {
      window.localStorage.setItem("gathergate-theme", "light");
    });
    const opPage = await opContext.newPage();
    await opPage.goto(`${BASE_URL}/login`);
    await opPage.getByLabel("Email").fill("ops@harbouradvisory.com.au");
    await opPage.getByLabel("Password", { exact: true }).fill("showcase-capture-123");
    await opPage.getByRole("button", { name: "Sign in" }).click();
    await opPage.waitForURL(`${BASE_URL}/`);
    await opPage.getByText("Harbourline Plumbing Pty Ltd").waitFor({ state: "visible" });
    await waitForSettled(opPage);
    await opPage.screenshot({
      path: path.join(SCREENSHOTS_DIR, "operator-dashboard.png"),
      fullPage: false,
      animations: "disabled",
    });

    await opPage.goto(`${BASE_URL}/requests/${basRequest.id}`);
    const csvRow = opPage.locator("li").filter({ hasText: ".csv" }).first();
    await csvRow.getByRole("button", { name: "Preview" }).click();
    const reviewDialog = opPage.getByRole("dialog");
    await reviewDialog.getByRole("button", { name: "Approve & next" }).waitFor({ state: "visible" });
    await reviewDialog
      .locator("pre")
      .filter({ hasText: "Date,Description,Reference,Debit,Credit,Balance" })
      .waitFor({ state: "visible" });
    await waitForSettled(opPage);
    await opPage.screenshot({
      path: path.join(SCREENSHOTS_DIR, "operator-review.png"),
      fullPage: false,
      animations: "disabled",
    });
    await opContext.close();

    // 2. Client portal desktop (fresh unauthenticated context)
    const desktopClientCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopClientPage = await desktopClientCtx.newPage();
    await desktopClientPage.goto(`${BASE_URL}/c/${basToken}`);
    await desktopClientPage.getByRole("heading", { name: "Q3 BAS & Supplier Pack" }).waitFor({ state: "visible" });
    await waitForSettled(desktopClientPage);
    await desktopClientPage.screenshot({
      path: path.join(SCREENSHOTS_DIR, "client-portal-desktop.png"),
      fullPage: false,
      animations: "disabled",
    });
    await desktopClientCtx.close();

    // 3. Client portal mobile (fresh unauthenticated touch context)
    const mobileClientCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const mobileClientPage = await mobileClientCtx.newPage();
    await mobileClientPage.goto(`${BASE_URL}/c/${basToken}`);
    const takePhotoButton = mobileClientPage.getByRole("button", { name: "Take a photo" });
    await takePhotoButton.waitFor({ state: "visible" });
    await mobileClientPage
      .locator("article")
      .filter({ hasText: "Missing Supplier Tax Invoices" })
      .first()
      .evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
    await waitForSettled(mobileClientPage);
    await mobileClientPage.screenshot({
      path: path.join(SCREENSHOTS_DIR, "client-portal-mobile.png"),
      fullPage: false,
      animations: "disabled",
    });
    await mobileClientCtx.close();

    console.log(`Captured 4 showcase screenshots into ${SCREENSHOTS_DIR}`);
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (db) db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
