// Captures 2x Retina showcase screenshots (Light & Dark), crisp animated WebP demo,
// and 1280x640 dark studio GitHub social preview / OpenGraph card.
import { execFileSync } from "node:child_process";
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
const PUBLIC_DIR = path.join(ROOT, "site", "public");
const GH_ASSETS_DIR = path.join(ROOT, ".github", "assets");

const STATEMENT_CSV = [
  "Date,Description,Reference,Debit,Credit,Balance",
  "2026-07-02,OPENING BALANCE B/F,Q3-OPEN,,,48210.45",
  "2026-07-07,DIRECT CREDIT CITY OF MELBOURNE INV-1042,CR-88412,,6840.00,55050.45",
  "2026-07-12,EFTPOS BAYSIDE PIPE & TRADE #219,INV-7731,1485.50,,53564.95",
  "2026-07-18,BPAY ATO BAS PAYMENT Q2,ATO-009241,4120.00,,49444.95",
  "2026-07-25,DIRECT CREDIT HARBOURSIDE STRATA INV-1049,CR-89105,,9450.00,58894.95",
  "2026-08-03,EFTPOS BUNNINGS TRADE ACCOUNT,TR-44018,892.35,,58002.60",
  "2026-08-14,DIRECT CREDIT BAYSIDE COMMERCIAL INV-1055,CR-90214,,7320.00,65322.60",
  "2026-09-02,EFTPOS ORIGIN ENERGY FLEET FUEL,FL-11820,612.50,,64710.10",
  "2026-09-29,BANK SERVICE FEE BUSINESS EVERYDAY,FEE-0926,30.00,,64680.10",
  "2026-09-30,CLOSING BALANCE C/F,Q3-CLOSE,,,64680.10",
].join("\n") + "\n";

const BRAND_MARK_DARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none">
  <path fill="#FAFAFA" d="M4 6H12V10H8V22H12V26H4V6ZM28 6H20V10H24V22H20V26H28V6Z"/>
  <rect fill="#22A882" x="14" y="10" width="4" height="12" rx="1"/>
</svg>`;

function loadFontFaceCss() {
  const interPath = path.join(
    ROOT,
    "client",
    "node_modules",
    "@fontsource-variable",
    "inter",
    "files",
    "inter-latin-wght-normal.woff2"
  );
  const monoPath = path.join(
    ROOT,
    "client",
    "node_modules",
    "@fontsource",
    "geist-mono",
    "files",
    "geist-mono-latin-500-normal.woff2"
  );
  const interB64 = fs.readFileSync(interPath).toString("base64");
  const monoB64 = fs.readFileSync(monoPath).toString("base64");
  return `
    @font-face {
      font-family: "Inter Variable";
      font-style: normal;
      font-weight: 100 900;
      src: url("data:font/woff2;base64,${interB64}") format("woff2");
    }
    @font-face {
      font-family: "Geist Mono";
      font-style: normal;
      font-weight: 500;
      src: url("data:font/woff2;base64,${monoB64}") format("woff2");
    }
  `;
}

function imgDataUrl(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
}

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

async function renderHtmlCard(browser, { width, height, html, outputPath, deviceScaleFactor = 1 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: outputPath, fullPage: false, animations: "disabled" });
  await ctx.close();
}

async function createTaxInvoiceFixture(browser, fontCss, outputPath) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${fontCss}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: 780px; height: 960px; background: #FFFFFF; color: #11181C;
  font-family: "Inter Variable", system-ui, sans-serif; padding: 48px 52px;
  display: flex; flex-direction: column; justify-content: space-between;
}
.top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0F5243; padding-bottom: 22px; }
.vendor { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: #0F5243; }
.meta { margin-top: 6px; font-size: 12.5px; color: #52605A; line-height: 1.55; }
.inv-tag { text-align: right; }
.inv-tag h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; color: #11181C; }
.inv-tag .mono { margin-top: 6px; font-family: "Geist Mono", monospace; font-size: 13px; color: #374151; line-height: 1.6; }
.bill { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 26px; padding: 18px 20px; background: #F8F9F7; border: 1px solid #E2E7E3; border-radius: 10px; }
.label { font-family: "Geist Mono", monospace; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #5B6B66; margin-bottom: 6px; }
.val { font-size: 13.5px; line-height: 1.55; color: #11181C; font-weight: 500; }
table { width: 100%; border-collapse: collapse; margin-top: 28px; }
th { text-align: left; font-family: "Geist Mono", monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #5B6B66; border-bottom: 1px solid #D1D8D4; padding: 10px 8px; }
td { font-size: 13.5px; padding: 13px 8px; border-bottom: 1px solid #EDF1EE; color: #18221E; }
.num { text-align: right; font-family: "Geist Mono", monospace; font-variant-numeric: tabular-nums; }
.totals { margin-top: 22px; margin-left: auto; width: 290px; }
.tot-row { display: flex; justify-content: space-between; padding: 7px 0; font-size: 13.5px; color: #4A5A53; }
.tot-row.final { border-top: 2px solid #11181C; margin-top: 6px; padding-top: 12px; font-size: 16px; font-weight: 700; color: #11181C; }
.tot-row .num { font-family: "Geist Mono", monospace; }
.footer { border-top: 1px solid #E2E7E3; padding-top: 18px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #5B6B66; }
.paid { font-family: "Geist Mono", monospace; font-size: 11.5px; font-weight: 600; color: #0F5243; background: #E6F2EE; border: 1px solid #BEE0D4; padding: 4px 10px; border-radius: 6px; }
</style></head>
<body>
  <div>
    <div class="top">
      <div>
        <div class="vendor">Bayside Pipe &amp; Trade Supplies Pty Ltd</div>
        <div class="meta">ABN 99 000 000 000 · 42 Example Trade Way, Port Melbourne VIC 3207<br>Trade Desk · (03) 7010 1111 · accounts@bayside-trade.example.com.au</div>
      </div>
      <div class="inv-tag">
        <h1>TAX INVOICE</h1>
        <div class="mono">Invoice #INV-7731<br>Issued 12 Jul 2026</div>
      </div>
    </div>
    <div class="bill">
      <div>
        <div class="label">Bill To</div>
        <div class="val">Harbourline Plumbing Pty Ltd<br>ABN 51 824 753 556<br>Unit 4, 28 Marine Parade, St Kilda VIC</div>
      </div>
      <div>
        <div class="label">Job Reference &amp; Payment</div>
        <div class="val">PO #HP-2026-091 · Bayside Strata Fitout<br>Paid via EFTPOS (NAB Business)<br>BSB 083-170 · Ref INV-7731</div>
      </div>
    </div>
    <table>
      <thead>
        <tr><th>Code</th><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>
        <tr><td class="mono">CU-1520</td><td>Kembla Copper Pipe Type B 15mm x 6m</td><td class="num">12</td><td class="num">$48.50</td><td class="num">$582.00</td></tr>
        <tr><td class="mono">PV-9042</td><td>Thermostatic Mixing Valve DN20 AS4032</td><td class="num">2</td><td class="num">$245.00</td><td class="num">$490.00</td></tr>
        <tr><td class="mono">BR-3310</td><td>Brass Compression Elbow 15mm (Trade Pack 20)</td><td class="num">3</td><td class="num">$64.15</td><td class="num">$192.45</td></tr>
        <tr><td class="mono">FR-0100</td><td>Trade Site Delivery - Melbourne Metro</td><td class="num">1</td><td class="num">$86.00</td><td class="num">$86.00</td></tr>
      </tbody>
    </table>
    <div class="totals">
      <div class="tot-row"><span>Subtotal (excl. GST)</span><span class="num">$1,350.45</span></div>
      <div class="tot-row"><span>GST (10%)</span><span class="num">$135.05</span></div>
      <div class="tot-row final"><span>Total AUD</span><span class="num">$1,485.50</span></div>
    </div>
  </div>
  <div class="footer">
    <span>Retained for Q3 BAS GST input tax credit verification</span>
    <span class="paid">PAID IN FULL · EFTPOS</span>
  </div>
</body></html>`;
  await renderHtmlCard(browser, { width: 780, height: 960, html, outputPath, deviceScaleFactor: 2 });
}

function buildSocialPreviewHtml(fontCss, dashboardDarkDataUrl, backdropDataUrl) {
  const bgCss = backdropDataUrl
    ? `background-image: linear-gradient(90deg, rgba(9,9,11,0.94) 0%, rgba(9,9,11,0.78) 46%, rgba(9,9,11,0.48) 100%), url("${backdropDataUrl}"); background-size: cover; background-position: center;`
    : `background: radial-gradient(circle at 82% 20%, rgba(34,168,130,0.16), transparent 52%), #09090B;`;
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
${fontCss}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: 1080px; height: 540px; overflow: hidden;
  ${bgCss}
  color: #FAFAFA;
  font-family: "Inter Variable", system-ui, sans-serif;
  display: grid; grid-template-columns: 394px 1fr; align-items: center;
  padding: 40px 40px 40px 48px; gap: 30px;
}
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.brand-name { font-size: 18px; font-weight: 600; letter-spacing: -0.025em; color: #FAFAFA; }
h1 { font-size: 39px; line-height: 1.06; font-weight: 650; letter-spacing: -0.035em; color: #FAFAFA; }
p { margin-top: 15px; font-size: 14px; line-height: 1.55; color: #A1A1AA; max-width: 38ch; }
.specs {
  margin-top: 24px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.10);
  font-family: "Geist Mono", monospace; font-size: 10.75px; letter-spacing: 0.01em; color: #D4D4D8;
  display: flex; align-items: center; gap: 8.5px; white-space: nowrap;
}
.dot-accent { color: #22A882; }
.frame {
  background: #121215; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(34, 168, 130, 0.14);
  display: flex; flex-direction: column;
}
.bar {
  height: 26px; background: #18181B; border-bottom: 1px solid rgba(255,255,255,0.08);
  display: flex; align-items: center; padding: 0 12px; gap: 6px;
  font-family: "Geist Mono", monospace; font-size: 10px; color: #A1A1AA;
}
.dot { width: 7.5px; height: 7.5px; border-radius: 999px; background: #3F3F46; }
.shot { width: 100%; height: auto; display: block; }
</style></head>
<body>
  <div>
    <div class="brand">
      ${BRAND_MARK_DARK_SVG}
      <span class="brand-name">GatherGate</span>
    </div>
    <h1>Client intake without the chase.</h1>
    <p>Self-hosted magic-link checklists, deterministic statutory validation, AES-256-GCM encryption, and keyboard review.</p>
    <div class="specs">
      <span>MIT</span><span class="dot-accent">·</span>
      <span>Docker</span><span class="dot-accent">·</span>
      <span>SQLite WAL</span><span class="dot-accent">·</span>
      <span>AES-256-GCM</span>
    </div>
  </div>
  <div class="frame">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span style="margin-left:8px;">gathergate.local/requests</span></div>
    <img class="shot" src="${dashboardDarkDataUrl}" alt="" />
  </div>
</body>
</html>`;
}

async function installCursorHelper(page) {
  await page.evaluate(() => {
    if (document.getElementById("__gg_cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #__gg_cursor {
        position: fixed; left: 0; top: 0; width: 22px; height: 22px;
        pointer-events: none; z-index: 2147483647; transform: translate3d(-100px, -100px, 0);
        filter: drop-shadow(0 2px 5px rgba(0,0,0,0.35));
      }
      #__gg_pulse {
        position: fixed; left: 0; top: 0; width: 28px; height: 28px; border-radius: 999px;
        border: 2px solid #22A882; background: rgba(34,168,130,0.18);
        pointer-events: none; z-index: 2147483646; opacity: 0;
        transform: translate3d(-100px, -100px, 0) scale(0.5);
      }
    `;
    document.head.appendChild(style);
    const pulse = document.createElement("div");
    pulse.id = "__gg_pulse";
    document.body.appendChild(pulse);

    const cursor = document.createElement("div");
    cursor.id = "__gg_cursor";
    cursor.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M4.5 2.5L18.5 12.2L11.6 13.7L8.4 20.2L4.5 2.5Z" fill="#11181C" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(cursor);

    window.__ggSetCursor = (x, y, pulseScale = 0) => {
      cursor.style.transform = `translate3d(${x - 4}px, ${y - 2}px, 0)`;
      if (pulseScale > 0) {
        pulse.style.opacity = String(Math.max(0, 1 - pulseScale));
        pulse.style.transform = `translate3d(${x - 14}px, ${y - 14}px, 0) scale(${0.4 + pulseScale * 0.9})`;
      } else {
        pulse.style.opacity = "0";
      }
    };
  });
}

async function captureInteractiveDemoFrames(browser, { basToken, basRequestId, invoicePath, framesDir }) {
  const frames = [];
  let cursorPos = { x: 640, y: 220 };

  const recordFrame = async (page, urlLabel, stepLabel) => {
    const idx = frames.length;
    const filePath = path.join(framesDir, `frame_${String(idx).padStart(4, "0")}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    frames.push({ file: path.basename(filePath), urlLabel, stepLabel });
  };

  const hold = async (page, count, urlLabel, stepLabel) => {
    for (let i = 0; i < count; i += 1) {
      await recordFrame(page, urlLabel, stepLabel);
    }
  };

  const moveCursorTo = async (page, targetX, targetY, steps, urlLabel, stepLabel) => {
    const startX = cursorPos.x;
    const startY = cursorPos.y;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const x = startX + (targetX - startX) * ease;
      const y = startY + (targetY - startY) * ease;
      await page.evaluate(([cx, cy]) => window.__ggSetCursor(cx, cy, 0), [x, y]);
      await recordFrame(page, urlLabel, stepLabel);
    }
    cursorPos = { x: targetX, y: targetY };
  };

  const clickPulse = async (page, urlLabel, stepLabel) => {
    for (const s of [0.15, 0.55, 0.9, 0]) {
      await page.evaluate(([cx, cy, sc]) => window.__ggSetCursor(cx, cy, sc), [cursorPos.x, cursorPos.y, s]);
      await recordFrame(page, urlLabel, stepLabel);
    }
  };

  // Part A: Client Portal (0 of 5 done -> inline ABN mod-89 error -> fix -> encrypted upload)
  const portalUrl = "portal.harbour.example.com.au/c/q3-bas";
  const clientCtx = await browser.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2 });
  const clientPage = await clientCtx.newPage();
  await clientPage.goto(`${BASE_URL}/c/${basToken}`);
  await clientPage.getByRole("heading", { name: "Q3 BAS & Bookkeeping Pack" }).waitFor({ state: "visible" });
  await waitForSettled(clientPage);
  await installCursorHelper(clientPage);
  await clientPage.evaluate(([cx, cy]) => window.__ggSetCursor(cx, cy, 0), [cursorPos.x, cursorPos.y]);
  await hold(clientPage, 8, portalUrl, "01 · PASSWORDLESS MAGIC LINK");

  const abnCard = clientPage.locator("article").filter({
    has: clientPage.getByRole("heading", { name: /Australian Business Number/i }),
  });
  const abnInput = abnCard.getByRole("textbox");
  const abnBox = await abnInput.boundingBox();
  await moveCursorTo(clientPage, abnBox.x + 140, abnBox.y + abnBox.height / 2, 8, portalUrl, "02 · INLINE ABN CHECKSUM");
  await abnInput.click();
  await clickPulse(clientPage, portalUrl, "02 · INLINE ABN CHECKSUM");

  for (const chunk of ["51 ", "824 ", "753 ", "557"]) {
    await abnInput.type(chunk, { delay: 0 });
    await recordFrame(clientPage, portalUrl, "02 · INLINE ABN CHECKSUM");
  }
  await abnInput.blur();
  await abnCard.getByText(/Invalid ABN checksum|mod-89/i).waitFor({ state: "visible" });
  await hold(clientPage, 16, portalUrl, "02 · ATO MOD-89 REJECTS BAD DIGIT");

  await abnInput.click();
  await clientPage.keyboard.press("Backspace");
  await recordFrame(clientPage, portalUrl, "02 · INLINE ABN CHECKSUM");
  await abnInput.type("6", { delay: 0 });
  await recordFrame(clientPage, portalUrl, "02 · INLINE ABN CHECKSUM");
  await abnInput.blur();
  await abnCard.locator('[title="Done"]').waitFor({ state: "visible" });
  await hold(clientPage, 12, portalUrl, "02 · VERIFIED & AUTO-SAVED");

  const invoiceCard = clientPage.locator("article").filter({
    has: clientPage.getByRole("heading", { name: /Missing Supplier Tax Invoices/i }),
  });
  await invoiceCard.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
  await hold(clientPage, 4, portalUrl, "03 · ENCRYPTED UPLOAD");
  await invoiceCard.locator('input[type="file"]').first().setInputFiles(invoicePath);
  await invoiceCard.getByText("bayside-trade-tax-invoice-7731.png").waitFor({ state: "visible" });
  await hold(clientPage, 14, portalUrl, "03 · MAGIC-BYTE & AES-256-GCM VERIFIED");
  await clientCtx.close();

  // Part B: Dark Mode Operator Console (ReviewSheet decrypted preview -> Approve & lock)
  const opUrl = "gathergate.local/requests/q3-bas";
  const opCtx = await browser.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2 });
  await opCtx.addInitScript(() => {
    window.localStorage.setItem("gathergate-theme", "dark");
  });
  const opPage = await opCtx.newPage();
  await opPage.goto(`${BASE_URL}/login`);
  await opPage.getByLabel("Email").fill("ops@harbouradvisory.example.com.au");
  await opPage.getByLabel("Password", { exact: true }).fill("showcase-capture-123");
  await opPage.getByRole("button", { name: "Sign in" }).click();
  await opPage.waitForURL(`${BASE_URL}/`);
  await opPage.goto(`${BASE_URL}/requests/${basRequestId}`);
  await opPage.getByText("bayside-trade-tax-invoice-7731.png").waitFor({ state: "visible" });
  await waitForSettled(opPage);
  await installCursorHelper(opPage);

  const previewBtn = opPage.locator("li").filter({ hasText: "bayside-trade-tax-invoice-7731.png" }).first().getByRole("button", { name: "Preview" });
  await previewBtn.scrollIntoViewIfNeeded();
  let prevBox = await previewBtn.boundingBox();
  if (!prevBox || prevBox.y < 0 || prevBox.y + prevBox.height > 720) {
    await previewBtn.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
    prevBox = await previewBtn.boundingBox();
  }
  if (!prevBox || prevBox.y < 0 || prevBox.y + prevBox.height > 720) {
    throw new Error(`Preview button outside 1200x720 viewport: ${JSON.stringify(prevBox)}`);
  }
  cursorPos = { x: 420, y: 260 };
  await opPage.evaluate(([cx, cy]) => window.__ggSetCursor(cx, cy, 0), [cursorPos.x, cursorPos.y]);
  await hold(opPage, 8, opUrl, "04 · OPERATOR REVIEW QUEUE");
  await moveCursorTo(opPage, prevBox.x + prevBox.width / 2, prevBox.y + prevBox.height / 2, 7, opUrl, "04 · KEYBOARD & INLINE REVIEW");
  await previewBtn.click();

  const reviewDialog = opPage.getByRole("dialog");
  await reviewDialog.locator("img").waitFor({ state: "visible" });
  await waitForSettled(opPage);
  await hold(opPage, 18, opUrl, "04 · DECRYPTED INLINE PREVIEW");

  cursorPos = { x: 760, y: 360 };
  await opPage.evaluate(([cx, cy]) => window.__ggSetCursor(cx, cy, 0), [cursorPos.x, cursorPos.y]);

  const approveBtn = reviewDialog.getByRole("button", { name: /Approve/i });
  const appBox = await approveBtn.boundingBox();
  await moveCursorTo(opPage, appBox.x + appBox.width / 2, appBox.y + appBox.height / 2, 7, opUrl, "04 · APPROVE & LOCK");
  await clickPulse(opPage, opUrl, "04 · APPROVE & LOCK");
  await approveBtn.click();
  await reviewDialog.waitFor({ state: "hidden" });
  const lockedCard = opPage.locator("[data-item-id]").filter({ hasText: "bayside-trade-tax-invoice-7731.png" }).first();
  await lockedCard.getByText("Locked").waitFor({ state: "visible" });
  await waitForSettled(opPage);
  await hold(opPage, 16, opUrl, "04 · ITEM LOCKED & AUDIT LOGGED");
  await opCtx.close();

  fs.writeFileSync(path.join(framesDir, "manifest.json"), JSON.stringify(frames, null, 2));
}

function runPythonMediaPipeline(args) {
  const pyScript = `
import json, os, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import imageio_ffmpeg

mode = sys.argv[1]
ff = imageio_ffmpeg.get_ffmpeg_exe()

if mode == "downscale":
    src = Path(sys.argv[2])
    dst = Path(sys.argv[3])
    w, h = int(sys.argv[4]), int(sys.argv[5])
    im = Image.open(src)
    if im.size != (w, h):
        im = im.resize((w, h), Image.Resampling.LANCZOS)
    im.save(dst, "PNG", optimize=True, compress_level=9)
    print(f"Saved {dst} ({dst.stat().st_size} bytes)")
elif mode == "optimize_social":
    src = Path(sys.argv[2])
    jpg_out = Path(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
    im = Image.open(src)
    im.save(src, "PNG", optimize=True, compress_level=9)
    print(f"Optimized social PNG: {src.stat().st_size} bytes")
    if jpg_out:
        im.convert("RGB").save(jpg_out, "JPEG", quality=94, subsampling=0, optimize=True)
        print(f"Saved GitHub upload JPG (<1MB): {jpg_out} ({jpg_out.stat().st_size} bytes)")
elif mode == "demo_webp":
    frames_dir = Path(sys.argv[2])
    out_webp = Path(sys.argv[3])
    font_path = sys.argv[4]
    manifest = json.loads((frames_dir / "manifest.json").read_text())
    composed_dir = frames_dir / "composed"
    composed_dir.mkdir(exist_ok=True)
    font = ImageFont.truetype(font_path, 20) if Path(font_path).exists() else ImageFont.load_default()

    W, H = 1920, 1200
    WIN_W, WIN_H = 1800, 1130
    BAR_H = 50
    OX, OY = (W - WIN_W) // 2, (H - WIN_H) // 2

    # Base obsidian stage with subtle emerald radial warmth
    stage_base = Image.new("RGBA", (W, H), (9, 9, 11, 255))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([1050, -270, 2190, 630], fill=(34, 168, 130, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=160))
    stage_base = Image.alpha_composite(stage_base, glow)

    mask = Image.new("L", (WIN_W, WIN_H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, WIN_W - 1, WIN_H - 1], radius=20, fill=255)

    for idx, entry in enumerate(manifest):
        shot = Image.open(frames_dir / entry["file"]).convert("RGBA")
        shot = shot.resize((WIN_W, WIN_H - BAR_H), Image.Resampling.LANCZOS)

        win = Image.new("RGBA", (WIN_W, WIN_H), (20, 20, 24, 255))
        wdraw = ImageDraw.Draw(win)
        wdraw.rectangle([0, 0, WIN_W, BAR_H], fill=(24, 24, 27, 255))
        wdraw.line([0, BAR_H - 1, WIN_W, BAR_H - 1], fill=(39, 39, 42, 255), width=1)
        for di, col in enumerate([(82, 82, 91, 255), (82, 82, 91, 255), (82, 82, 91, 255)]):
            cx = 24 + di * 22
            wdraw.ellipse([cx, 18, cx + 13, 31], fill=col)
        wdraw.text((104, 13), entry["urlLabel"], fill=(161, 161, 170, 255), font=font)
        step_txt = entry["stepLabel"]
        tb = wdraw.textbbox((0, 0), step_txt, font=font)
        wdraw.text((WIN_W - 26 - (tb[2] - tb[0]), 13), step_txt, fill=(34, 168, 130, 255), font=font)

        win.paste(shot, (0, BAR_H))

        # Apply crisp rounded window mask + 1px hairline border
        canvas = stage_base.copy()
        canvas.paste(win, (OX, OY), mask)
        cdraw = ImageDraw.Draw(canvas)
        cdraw.rounded_rectangle([OX, OY, OX + WIN_W - 1, OY + WIN_H - 1], radius=20, outline=(255, 255, 255, 34), width=2)
        canvas.convert("RGB").save(composed_dir / f"comp_{idx:04d}.png", "PNG")

    for lossless, q, preset in [(True, 90, "drawing"), (False, 90, "default"), (False, 84, "default")]:
        cmd = [
            ff, "-y", "-framerate", "12",
            "-i", str(composed_dir / "comp_%04d.png"),
            "-c:v", "libwebp_anim",
            "-lossless", "1" if lossless else "0",
            "-q:v", str(q),
            "-compression_level", "6",
        ]
        if preset != "default":
            cmd.extend(["-preset", preset])
        cmd.extend(["-loop", "0", "-an", str(out_webp)])
        subprocess.run(cmd, check=True)
        size = out_webp.stat().st_size
        print(f"Encoded WebP lossless={lossless} q={q}: {size} bytes")
        if size <= 4_500_000:
            break
`;
  const tmpPy = path.join(os.tmpdir(), "gg_media_pipeline.py");
  fs.writeFileSync(tmpPy, pyScript, "utf8");
  execFileSync("uv", ["run", "--with", "pillow", "--with", "imageio-ffmpeg", "python", tmpPy, ...args], {
    stdio: "inherit",
  });
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(GH_ASSETS_DIR, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-showcase-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-frames-"));
  const framesDir = path.join(workDir, "demo-frames");
  fs.mkdirSync(framesDir, { recursive: true });

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
        email: "ops@harbouradvisory.example.com.au",
        password: "showcase-capture-123",
        loadDemo: true,
      }),
    });
    const rawCookie = setupRes.headers.getSetCookie?.()[0] || setupRes.headers.get("set-cookie") || "";
    const sessionCookie = rawCookie.split(";")[0];
    if (!sessionCookie) throw new Error("Missing session cookie from POST /api/setup");

    await apiJson(`${BASE_URL}/api/account`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({ displayName: "Intake Desk", email: "ops@harbouradvisory.example.com.au" }),
    });

    await apiJson(`${BASE_URL}/api/settings/branding`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({
        brandColor: "#0F5243",
        supportEmail: "help@harbouradvisory.example.com.au",
        supportPhone: "+61 3 9000 4120",
        logoDataUrl: null,
      }),
    });

    const tplsRes = await apiJson(`${BASE_URL}/api/templates`, { headers: { cookie: sessionCookie } });
    const { templates } = await tplsRes.json();
    const agencyTpl = templates.find((t) => t.name.includes("Agency"));
    const basTpl = templates.find((t) => t.name.includes("AU Company / BAS"));
    if (!agencyTpl || !basTpl) throw new Error("Missing built-in templates");

    // Seed 2 additional realistic packs so dashboard shows 5 balanced production rows.
    const dueBayside = new Date(Date.now() + 4 * 86400_000).toISOString();
    const agencyCreated = await (
      await apiJson(`${BASE_URL}/api/requests`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: sessionCookie },
        body: JSON.stringify({
          templateId: agencyTpl.id,
          title: "Website & Brand Onboarding",
          clientName: "Bayside Studio Pty Ltd",
          clientEmail: "hello@baysidestudio.example.com.au",
          dueAt: dueBayside,
          requireOtp: false,
        }),
      })
    ).json();
    const agencyToken = new URL(agencyCreated.portalUrl).pathname.split("/c/")[1];
    const agencyDetail = await (
      await apiJson(`${BASE_URL}/api/requests/${agencyCreated.id}`, { headers: { cookie: sessionCookie } })
    ).json();
    const agencyEmailItem = agencyDetail.items.find((i) => i.validator === "email");
    if (agencyEmailItem) {
      await apiJson(`${BASE_URL}/api/client/${agencyToken}/items/${agencyEmailItem.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "projects@baysidestudio.example.com.au" }),
      });
    }

    const dueBrooks = new Date(Date.now() + 3 * 86400_000).toISOString();
    const brooksCreated = await (
      await apiJson(`${BASE_URL}/api/requests`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: sessionCookie },
        body: JSON.stringify({
          templateId: basTpl.id,
          title: "Q3 BAS & Bookkeeping Pack",
          clientName: "Daniel Brooks",
          clientEmail: "daniel@brooksbuild.example.com.au",
          dueAt: dueBrooks,
          requireOtp: false,
        }),
      })
    ).json();
    const brooksToken = new URL(brooksCreated.portalUrl).pathname.split("/c/")[1];

    // Strip demo flags so screenshots represent real production workspace UI.
    db.prepare("UPDATE requests SET is_demo = 0").run();
    db.prepare("UPDATE outbox_emails SET is_demo = 0").run();

    const listRes = await apiJson(`${BASE_URL}/api/requests`, { headers: { cookie: sessionCookie } });
    const listData = await listRes.json();
    const harbourBasReq = listData.requests.find((r) => r.title === "Q3 BAS & Supplier Pack");
    if (!harbourBasReq) throw new Error("Seeded Q3 BAS & Supplier Pack not found");
    const harbourToken = new URL(harbourBasReq.portal_url).pathname.split("/c/")[1];

    const fontCss = loadFontFaceCss();
    const invoicePath = path.join(workDir, "bayside-trade-tax-invoice-7731.png");

    browser = await chromium.launch();
    await createTaxInvoiceFixture(browser, fontCss, invoicePath);

    // 1. Capture smooth 2x animated WebP workflow from fresh Daniel Brooks BAS pack (0 of 5 done -> ReviewSheet approve).
    await captureInteractiveDemoFrames(browser, {
      basToken: brooksToken,
      basRequestId: brooksCreated.id,
      invoicePath,
      framesDir,
    });
    const monoFontPath = path.join(
      ROOT,
      "client",
      "node_modules",
      "@fontsource",
      "geist-mono",
      "files",
      "geist-mono-latin-500-normal.woff2"
    );
    runPythonMediaPipeline([
      "demo_webp",
      framesDir,
      path.join(GH_ASSETS_DIR, "demo-workflow.webp"),
      monoFontPath,
    ]);

    // 2. Upload realistic Tax Invoice PNG into Harbourline BAS pack for static ReviewSheet shots.
    const harbourDetail = await (
      await apiJson(`${BASE_URL}/api/requests/${harbourBasReq.id}`, { headers: { cookie: sessionCookie } })
    ).json();
    const supplierItem = harbourDetail.items.find((i) => i.label.includes("Missing Supplier Tax Invoices"));
    if (!supplierItem) throw new Error("Expected BAS supplier invoice checklist item not found");

    const formInv = new FormData();
    formInv.append("file", new Blob([fs.readFileSync(invoicePath)], { type: "image/png" }), "bayside-trade-tax-invoice-7731.png");
    await apiJson(`${BASE_URL}/api/client/${harbourToken}/items/${supplierItem.id}`, {
      method: "POST",
      body: formInv,
    });

    // Also add BSB + Bank Statement on Daniel Brooks pack so static desktop & mobile portal shots look realistic & active.
    const brooksDetail = await (
      await apiJson(`${BASE_URL}/api/requests/${brooksCreated.id}`, { headers: { cookie: sessionCookie } })
    ).json();
    const brooksBsb = brooksDetail.items.find((i) => i.validator === "au_bsb");
    const brooksBank = brooksDetail.items.find((i) => i.label.includes("Bank Statements"));
    if (brooksBsb) {
      await apiJson(`${BASE_URL}/api/client/${brooksToken}/items/${brooksBsb.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "083-170" }),
      });
    }
    if (brooksBank) {
      const formBrooks = new FormData();
      formBrooks.append("file", new Blob([Buffer.from(STATEMENT_CSV)], { type: "text/csv" }), "nab-q3-business-statement.csv");
      await apiJson(`${BASE_URL}/api/client/${brooksToken}/items/${brooksBank.id}`, {
        method: "POST",
        body: formBrooks,
      });
    }

    // 3. Static 2x Retina Operator Dashboard & ReviewSheet (Light + Dark, 1440x900 @ 2x -> 1920x1200)
    const captureOperatorPair = async (theme, dashOut, reviewOut) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await ctx.addInitScript((t) => window.localStorage.setItem("gathergate-theme", t), theme);
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/login`);
      await page.getByLabel("Email").fill("ops@harbouradvisory.example.com.au");
      await page.getByLabel("Password", { exact: true }).fill("showcase-capture-123");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(`${BASE_URL}/`);
      await page.getByText("Harbourline Plumbing Pty Ltd").waitFor({ state: "visible" });
      await waitForSettled(page);
      const rawDash = path.join(workDir, `dash-${theme}.png`);
      await page.screenshot({ path: rawDash, fullPage: false, animations: "disabled" });
      runPythonMediaPipeline(["downscale", rawDash, dashOut, "1920", "1200"]);

      await page.goto(`${BASE_URL}/requests/${harbourBasReq.id}`);
      const invRow = page.locator("li").filter({ hasText: "bayside-trade-tax-invoice-7731.png" }).first();
      await invRow.getByRole("button", { name: "Preview" }).click();
      const reviewDialog = page.getByRole("dialog");
      await reviewDialog.locator("img").waitFor({ state: "visible" });
      await reviewDialog.getByRole("button", { name: "Approve & next" }).waitFor({ state: "visible" });
      await waitForSettled(page);
      const rawRev = path.join(workDir, `rev-${theme}.png`);
      await page.screenshot({ path: rawRev, fullPage: false, animations: "disabled" });
      runPythonMediaPipeline(["downscale", rawRev, reviewOut, "1920", "1200"]);
      await ctx.close();
    };

    await captureOperatorPair(
      "light",
      path.join(SCREENSHOTS_DIR, "operator-dashboard.png"),
      path.join(SCREENSHOTS_DIR, "operator-review.png")
    );
    await captureOperatorPair(
      "dark",
      path.join(GH_ASSETS_DIR, "dashboard-dark.png"),
      path.join(GH_ASSETS_DIR, "review-dark.png")
    );
    fs.copyFileSync(path.join(GH_ASSETS_DIR, "dashboard-dark.png"), path.join(SCREENSHOTS_DIR, "operator-dashboard-dark.png"));
    fs.copyFileSync(path.join(GH_ASSETS_DIR, "review-dark.png"), path.join(SCREENSHOTS_DIR, "operator-review-dark.png"));

    // 4. Client portal desktop (2x -> 1920x1200)
    const desktopClientCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const desktopClientPage = await desktopClientCtx.newPage();
    await desktopClientPage.goto(`${BASE_URL}/c/${brooksToken}`);
    await desktopClientPage.getByRole("heading", { name: "Q3 BAS & Bookkeeping Pack" }).waitFor({ state: "visible" });
    await waitForSettled(desktopClientPage);
    const rawPortalDesktop = path.join(workDir, "portal-desktop.png");
    await desktopClientPage.screenshot({ path: rawPortalDesktop, fullPage: false, animations: "disabled" });
    runPythonMediaPipeline(["downscale", rawPortalDesktop, path.join(SCREENSHOTS_DIR, "client-portal-desktop.png"), "1920", "1200"]);
    await desktopClientCtx.close();

    // 5. Client portal mobile (390x844 @ 3x = 1170x2532, cleanly aligned card below sticky header)
    db.prepare("UPDATE request_items SET status = 'submitted' WHERE request_id = ? AND status = 'approved'").run(
      brooksCreated.id
    );
    const mobileClientCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const mobileClientPage = await mobileClientCtx.newPage();
    await mobileClientPage.goto(`${BASE_URL}/c/${brooksToken}`);
    await mobileClientPage.getByRole("button", { name: "Take a photo" }).waitFor({ state: "visible" });
    await mobileClientPage.evaluate(() => {
      const target = Array.from(document.querySelectorAll("section")).find((s) =>
        s.textContent?.includes("Quarter Records")
      );
      if (target) {
        const y = target.getBoundingClientRect().top + window.scrollY - 76;
        window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
      }
    });
    await waitForSettled(mobileClientPage);
    await mobileClientPage.screenshot({
      path: path.join(SCREENSHOTS_DIR, "client-portal-mobile.png"),
      fullPage: false,
      animations: "disabled",
    });
    await mobileClientCtx.close();

    // 6. 2160x1080 (1080p) Dark Studio Social Preview & OpenGraph Card
    const dashboardDarkDataUrl = imgDataUrl(path.join(GH_ASSETS_DIR, "dashboard-dark.png"));
    const backdropOverride = process.env.GG_DARK_BACKDROP ? imgDataUrl(process.env.GG_DARK_BACKDROP) : null;
    const siteSocialPath = path.join(PUBLIC_DIR, "social-preview.png");
    await renderHtmlCard(browser, {
      width: 1080,
      height: 540,
      html: buildSocialPreviewHtml(fontCss, dashboardDarkDataUrl, backdropOverride),
      outputPath: siteSocialPath,
      deviceScaleFactor: 2,
    });
    const socialJpgOut = process.env.GG_SOCIAL_JPG_OUT || "";
    runPythonMediaPipeline(["optimize_social", siteSocialPath, socialJpgOut]);
    fs.copyFileSync(siteSocialPath, path.join(GH_ASSETS_DIR, "social-preview.png"));

    // Remove obsolete blurry GIF if still present.
    const oldGif = path.join(SCREENSHOTS_DIR, "hero-demo.gif");
    if (fs.existsSync(oldGif)) fs.unlinkSync(oldGif);

    console.log(`Captured 2x screenshots, demo-workflow.webp, and social-preview.png`);
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (db) db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
