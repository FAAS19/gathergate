// Captures showcase screenshots, 15s hero workflow GIF, 1280x640 social preview,
// and optional 1270x760 Product Hunt gallery slides (when LAUNCH_DIR is set).
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
const LAUNCH_DIR = process.env.LAUNCH_DIR ? path.resolve(process.env.LAUNCH_DIR) : null;

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

const BRAND_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="36" height="36" fill="none">
  <rect fill="#0F5243" x="1" y="1" width="26" height="26" rx="7"/>
  <path d="M9.5 8.5H8a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1.5M18.5 8.5H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-1.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M11 14.25 13.1 16.35 17.25 11.75" stroke="#FFFFFF" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Zero-dependency GIF89a encoder using 5-5-5 RGB median-cut palette + 12-bit LZW.
function buildPalette(rgbaFrames) {
  const counts = new Uint32Array(32768);
  for (const rgba of rgbaFrames) {
    for (let i = 0; i < rgba.length; i += 4) {
      const idx = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
      counts[idx] += 1;
    }
  }

  const buckets = [];
  for (let i = 0; i < 32768; i += 1) {
    if (counts[i] > 0) {
      buckets.push({
        r: ((i >> 10) & 31) * 8 + 4,
        g: ((i >> 5) & 31) * 8 + 4,
        b: (i & 31) * 8 + 4,
        count: counts[i],
      });
    }
  }

  const boxes = [buckets];
  while (boxes.length < 256) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (const c of box) {
        if (c.r < rMin) rMin = c.r;
        if (c.r > rMax) rMax = c.r;
        if (c.g < gMin) gMin = c.g;
        if (c.g > gMax) gMax = c.g;
        if (c.b < bMin) bMin = c.b;
        if (c.b > bMax) bMax = c.b;
      }
      const range = Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
      const score = range * box.length;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const box = boxes.splice(bestIdx, 1)[0];
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const c of box) {
      if (c.r < rMin) rMin = c.r;
      if (c.r > rMax) rMax = c.r;
      if (c.g < gMin) gMin = c.g;
      if (c.g > gMax) gMax = c.g;
      if (c.b < bMin) bMin = c.b;
      if (c.b > bMax) bMax = c.b;
    }
    const ch = rMax - rMin >= gMax - gMin && rMax - rMin >= bMax - bMin ? "r" : gMax - gMin >= bMax - bMin ? "g" : "b";
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = Math.max(1, box.length >> 1);
    boxes.push(box.slice(0, mid), box.slice(mid));
  }

  const palette = new Uint8Array(256 * 3);
  const usedColors = Math.min(256, boxes.length);
  for (let i = 0; i < usedColors; i += 1) {
    let rSum = 0, gSum = 0, bSum = 0, total = 0;
    for (const c of boxes[i]) {
      rSum += c.r * c.count;
      gSum += c.g * c.count;
      bSum += c.b * c.count;
      total += c.count;
    }
    palette[i * 3] = Math.round(rSum / total);
    palette[i * 3 + 1] = Math.round(gSum / total);
    palette[i * 3 + 2] = Math.round(bSum / total);
  }

  const lut = new Uint8Array(32768);
  for (let i = 0; i < 32768; i += 1) {
    if (counts[i] === 0) continue;
    const r = ((i >> 10) & 31) * 8 + 4;
    const g = ((i >> 5) & 31) * 8 + 4;
    const b = (i & 31) * 8 + 4;
    let best = 0;
    let bestDist = Infinity;
    for (let p = 0; p < usedColors; p += 1) {
      const dr = r - palette[p * 3];
      const dg = g - palette[p * 3 + 1];
      const db = b - palette[p * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    lut[i] = best;
  }
  return { palette, lut };
}

function lzwEncode(indices) {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emit = (code, size) => {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  emit(clearCode, codeSize);
  let prefix = indices[0];

  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emit(prefix, codeSize);
      if (nextCode < 4096) {
        dict.set(key, nextCode);
        nextCode += 1;
        if (nextCode > 1 << codeSize && codeSize < 12) {
          codeSize += 1;
        }
      } else {
        emit(clearCode, codeSize);
        dict = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      prefix = k;
    }
  }
  emit(prefix, codeSize);
  emit(eoiCode, codeSize);
  if (bitCount > 0) out.push(bitBuf & 0xff);

  const blocks = [minCodeSize];
  for (let i = 0; i < out.length; i += 255) {
    const chunkLen = Math.min(255, out.length - i);
    blocks.push(chunkLen);
    for (let j = 0; j < chunkLen; j += 1) blocks.push(out[i + j]);
  }
  blocks.push(0);
  return Buffer.from(blocks);
}

async function decodeFramesToRgba(browser, frames, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const decoded = [];
  try {
    for (const frame of frames) {
      const dataUrl = imgDataUrl(frame.path);
      const b64 = await page.evaluate(
        ({ src, w, h }) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement("canvas");
              canvas.width = w;
              canvas.height = h;
              const g = canvas.getContext("2d");
              g.imageSmoothingEnabled = true;
              g.imageSmoothingQuality = "high";
              g.drawImage(img, 0, 0, w, h);
              const bytes = g.getImageData(0, 0, w, h).data;
              let bin = "";
              for (let i = 0; i < bytes.length; i += 8192) {
                bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
              }
              resolve(btoa(bin));
            };
            img.onerror = () => reject(new Error("Failed to decode PNG frame"));
            img.src = src;
          }),
        { src: dataUrl, w: width, h: height }
      );
      decoded.push(new Uint8Array(Buffer.from(b64, "base64")));
    }
  } finally {
    await ctx.close();
  }
  return decoded;
}

async function buildGifFromFrames(browser, frames, outputPath, width = 960, height = 600) {
  const rgbaFrames = await decodeFramesToRgba(browser, frames, width, height);
  const { palette, lut } = buildPalette(rgbaFrames);

  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf7; // Global Color Table flag + 8-bit color resolution + 256 entries
  header[11] = 0;
  header[12] = 0;

  const netscapeLoop = Buffer.from([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00,
  ]);

  const chunks = [header, Buffer.from(palette), netscapeLoop];
  const pixelCount = width * height;

  for (let f = 0; f < rgbaFrames.length; f += 1) {
    const rgba = rgbaFrames[f];
    const indices = new Uint8Array(pixelCount);
    for (let p = 0, i = 0; p < pixelCount; p += 1, i += 4) {
      indices[p] = lut[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
    }

    const delayCs = Math.max(10, Math.round(frames[f].duration * 100));
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 0x04;
    gce.writeUInt16LE(delayCs, 4);
    gce[6] = 0x00;
    gce[7] = 0x00;

    const imgDesc = Buffer.alloc(10);
    imgDesc[0] = 0x2c;
    imgDesc.writeUInt16LE(0, 1);
    imgDesc.writeUInt16LE(0, 3);
    imgDesc.writeUInt16LE(width, 5);
    imgDesc.writeUInt16LE(height, 7);
    imgDesc[9] = 0x00;

    chunks.push(gce, imgDesc, lzwEncode(indices));
  }

  chunks.push(Buffer.from([0x3b]));
  fs.writeFileSync(outputPath, Buffer.concat(chunks));
}

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

async function renderHtmlCard(browser, { width, height, html, outputPath }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: outputPath, fullPage: false, animations: "disabled" });
  await ctx.close();
}

async function captureHeroGif(browser, { basToken, basRequestId, gifDir }) {
  const frames = [];
  const snap = async (page, name, duration, caption) => {
    const filePath = path.join(gifDir, `${String(frames.length + 1).padStart(2, "0")}-${name}.png`);
    if (caption) {
      await page.evaluate((text) => {
        let el = document.getElementById("__gg_demo_caption");
        if (!el) {
          el = document.createElement("div");
          el.id = "__gg_demo_caption";
          Object.assign(el.style, {
            position: "fixed",
            left: "50%",
            bottom: "18px",
            transform: "translateX(-50%)",
            background: "rgba(15, 23, 20, 0.92)",
            color: "#F8F9F7",
            padding: "8px 16px",
            borderRadius: "999px",
            fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
            fontSize: "13px",
            fontWeight: "500",
            letterSpacing: "-0.01em",
            border: "1px solid rgba(255,255,255,0.14)",
            zIndex: "2147483647",
            whiteSpace: "nowrap",
          });
          document.body.appendChild(el);
        }
        el.textContent = text;
      }, caption);
    }
    await waitForSettled(page);
    await page.screenshot({ path: filePath, fullPage: false, animations: "disabled" });
    frames.push({ path: filePath, duration });
  };

  // Part A: Client Portal (invalid ABN caught inline -> corrected -> CSV uploaded)
  const clientCtx = await browser.newContext({ viewport: { width: 1200, height: 750 } });
  const clientPage = await clientCtx.newPage();
  await clientPage.goto(`${BASE_URL}/c/${basToken}`);
  await clientPage.getByRole("heading", { name: "Q3 BAS & Supplier Pack" }).waitFor({ state: "visible" });
  await snap(clientPage, "portal-open", 1.8, "1. Client opens passwordless magic link");

  const abnCard = clientPage.locator("article").filter({
    has: clientPage.getByRole("heading", { name: /Australian Business Number/i }),
  });
  await abnCard.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
  const abnInput = abnCard.getByRole("textbox");
  await abnInput.fill("51 824 753 557");
  await abnInput.blur();
  await abnCard.getByText(/Invalid ABN checksum|mod-89/i).waitFor({ state: "visible" });
  await snap(clientPage, "abn-invalid", 2.4, "2. Bad ABN checksum caught inline before submission");

  await abnInput.fill("51 824 753 556");
  await abnInput.blur();
  await abnCard.locator('[title="Done"]').waitFor({ state: "visible" });
  await snap(clientPage, "abn-valid", 2.0, "3. Valid ABN normalised and auto-saved");

  const bankCard = clientPage.locator("article").filter({
    has: clientPage.getByRole("heading", { name: /Bank Statements/i }),
  });
  await bankCard.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
  await bankCard.locator('input[type="file"]').first().setInputFiles({
    name: "nab-q3-business-statement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(STATEMENT_CSV),
  });
  await bankCard.getByText("nab-q3-business-statement.csv").waitFor({ state: "visible" });
  await snap(clientPage, "csv-uploaded", 2.2, "4. Bank statement verified by magic bytes and AES-256-GCM encrypted");
  await clientCtx.close();

  // Also submit the second document item so operator ReviewSheet steps cleanly with Approve & next.
  const supplierCardCtx = await browser.newContext({ viewport: { width: 1200, height: 750 } });
  const supplierPage = await supplierCardCtx.newPage();
  await supplierPage.goto(`${BASE_URL}/c/${basToken}`);
  const supplierCard = supplierPage.locator("article").filter({
    has: supplierPage.getByRole("heading", { name: /Missing Supplier Tax Invoices/i }),
  });
  await supplierCard.locator('input[type="file"]').first().setInputFiles({
    name: "reece-plumbing-invoice-7731.pdf",
    mimeType: "application/pdf",
    buffer: SAMPLE_PDF,
  });
  await supplierCard.getByText("reece-plumbing-invoice-7731.pdf").waitFor({ state: "visible" });
  await supplierCardCtx.close();

  // Part B: Operator keyboard-first continuous review (J -> Space -> A)
  const opCtx = await browser.newContext({ viewport: { width: 1200, height: 750 } });
  await opCtx.addInitScript(() => {
    window.localStorage.setItem("gathergate-theme", "light");
  });
  const opPage = await opCtx.newPage();
  await opPage.goto(`${BASE_URL}/login`);
  await opPage.getByLabel("Email").fill("ops@harbouradvisory.com.au");
  await opPage.getByLabel("Password", { exact: true }).fill("showcase-capture-123");
  await opPage.getByRole("button", { name: "Sign in" }).click();
  await opPage.waitForURL(`${BASE_URL}/`);
  await opPage.goto(`${BASE_URL}/requests/${basRequestId}`);
  await opPage.getByText("nab-q3-business-statement.csv").waitFor({ state: "visible" });

  // Focus heading and step down with J onto the submitted Bank Statements item
  await opPage.getByRole("heading", { name: "Q3 BAS & Supplier Pack" }).click();
  await opPage.keyboard.press("j");
  await opPage.keyboard.press("j");
  await opPage.keyboard.press("j");
  await snap(opPage, "operator-select-j", 1.8, "5. Operator triages queue with keyboard (J / K / Space / A)");

  const csvRow = opPage.locator("li").filter({ hasText: ".csv" }).first();
  await csvRow.getByRole("button", { name: "Preview" }).click();
  const reviewDialog = opPage.getByRole("dialog");
  await reviewDialog.getByRole("button", { name: "Approve & next" }).waitFor({ state: "visible" });
  await reviewDialog
    .locator("pre")
    .filter({ hasText: "Date,Description,Reference,Debit,Credit,Balance" })
    .waitFor({ state: "visible" });
  await snap(opPage, "operator-preview-space", 2.4, "6. Inline decrypted preview opens without downloading files");

  await reviewDialog.getByRole("button", { name: "Approve & next" }).click();
  await reviewDialog.getByText(/2 of 2|reece-plumbing/i).first().waitFor({ state: "visible" });
  await snap(opPage, "operator-approve-next", 2.2, "7. Approve & next locks item and advances immediately");
  await opCtx.close();

  await buildGifFromFrames(browser, frames, path.join(SCREENSHOTS_DIR, "hero-demo.gif"));
  return path.join(gifDir, "02-abn-invalid.png");
}

function buildSocialPreviewHtml(fontCss, dashboardDataUrl) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
${fontCss}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: 1280px; height: 640px; overflow: hidden;
  background: #F8F9F7; color: #111815;
  font-family: "Inter Variable", system-ui, sans-serif;
  display: grid; grid-template-columns: 455px 1fr; align-items: center;
  padding: 44px 44px 44px 54px; gap: 34px;
}
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
.brand-name { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; color: #111815; }
.badge { font-family: "Geist Mono", monospace; font-size: 12px; color: #0F5243; background: #E7F2EE; border: 1px solid #C5DFD6; padding: 3px 9px; border-radius: 999px; margin-left: 6px; }
h1 { font-size: 46px; line-height: 1.06; font-weight: 650; letter-spacing: -0.035em; color: #111815; }
p { margin-top: 18px; font-size: 17px; line-height: 1.5; color: #4A5A53; max-width: 36ch; }
.meta { margin-top: 26px; display: flex; gap: 10px; flex-wrap: wrap; font-family: "Geist Mono", monospace; font-size: 12.5px; color: #36453E; }
.chip { background: #FFFFFF; border: 1px solid #DCE3DE; border-radius: 8px; padding: 6px 11px; }
.frame {
  background: #FFFFFF; border: 1px solid #D9E1DC; border-radius: 14px; overflow: hidden;
  box-shadow: 0 24px 60px rgba(15, 36, 28, 0.12), 0 2px 8px rgba(15, 36, 28, 0.06);
  display: flex; flex-direction: column;
}
.bar { height: 32px; background: #F1F4F2; border-bottom: 1px solid #E2E7E3; display: flex; align-items: center; padding: 0 14px; gap: 8px; font-family: "Geist Mono", monospace; font-size: 12px; color: #56665F; }
.dot { width: 9px; height: 9px; border-radius: 999px; background: #CFD8D3; }
.shot { width: 100%; height: auto; display: block; }
</style></head>
<body>
  <div>
    <div class="brand">
      ${BRAND_MARK_SVG}
      <span class="brand-name">GatherGate</span>
      <span class="badge">MIT · Self-Hosted</span>
    </div>
    <h1>Stop chasing clients for documents.</h1>
    <p>Magic-link checklists with deterministic validation, AES-256-GCM encryption, and automated reminders in one container.</p>
    <div class="meta">
      <span class="chip">Docker + SQLite WAL</span>
      <span class="chip">Zero SaaS lock-in</span>
      <span class="chip">J / K / A review</span>
    </div>
  </div>
  <div class="frame">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span style="margin-left:8px;">gathergate.local/requests</span></div>
    <img class="shot" src="${dashboardDataUrl}" alt="" />
  </div>
</body>
</html>`;
}

function buildPhSlideHtml(fontCss, { kicker, title, subtitle, bodyHtml }) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
${fontCss}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: 1270px; height: 760px; overflow: hidden;
  background: #F8F9F7; color: #111815;
  font-family: "Inter Variable", system-ui, sans-serif;
  padding: 46px 56px 40px; display: flex; flex-direction: column; justify-content: space-between;
}
.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; }
.kicker { font-family: "Geist Mono", monospace; font-size: 13px; color: #0F5243; letter-spacing: 0.02em; margin-bottom: 10px; }
h1 { font-size: 38px; line-height: 1.1; font-weight: 650; letter-spacing: -0.03em; color: #111815; }
.sub { margin-top: 10px; font-size: 17px; color: #4A5A53; max-width: 64ch; }
.brand { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.brand-name { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; }
.stage { margin-top: 26px; flex: 1; display: flex; align-items: stretch; gap: 24px; min-height: 0; }
.frame {
  flex: 1; background: #FFFFFF; border: 1px solid #D9E1DC; border-radius: 14px; overflow: hidden;
  box-shadow: 0 20px 50px rgba(15, 36, 28, 0.10); display: flex; flex-direction: column;
}
.frame img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
.frame.contain { align-items: center; justify-content: center; background: #F1F4F2; }
.frame.contain img { width: 100%; height: 100%; object-fit: contain; object-position: center; }
.mobile-frame {
  width: 260px; flex-shrink: 0; background: #FFFFFF; border: 1px solid #D9E1DC; border-radius: 26px;
  padding: 10px; box-shadow: 0 20px 50px rgba(15, 36, 28, 0.12);
}
.mobile-frame img { width: 100%; height: 100%; object-fit: cover; object-position: top center; border-radius: 18px; display: block; }
.code-card {
  flex: 1; background: #0E1714; color: #E8F0EC; border-radius: 14px; padding: 34px 38px;
  display: flex; flex-direction: column; justify-content: center; gap: 22px;
  box-shadow: 0 20px 50px rgba(15, 36, 28, 0.16);
}
.code-label { font-family: "Geist Mono", monospace; font-size: 13px; color: #7CC8B0; }
pre {
  font-family: "Geist Mono", monospace; font-size: 16px; line-height: 1.6;
  background: #16231F; border: 1px solid #263B34; border-radius: 10px; padding: 18px 20px;
  white-space: pre-wrap; word-break: break-all; color: #F4F9F6;
}
.specs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.spec { background: #FFFFFF; border: 1px solid #DCE3DE; border-radius: 12px; padding: 20px; }
.spec h3 { font-size: 16px; font-weight: 600; color: #111815; margin-bottom: 6px; }
.spec p { font-size: 14px; line-height: 1.45; color: #4A5A53; }
</style></head>
<body>
  <div class="top">
    <div>
      <div class="kicker">${kicker}</div>
      <h1>${title}</h1>
      <p class="sub">${subtitle}</p>
    </div>
    <div class="brand">${BRAND_MARK_SVG}<span class="brand-name">GatherGate</span></div>
  </div>
  <div class="stage">${bodyHtml}</div>
</body>
</html>`;
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-showcase-"));
  const gifDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-frames-"));

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

    browser = await chromium.launch();

    // Capture the 15s animated workflow GIF first (while BAS pack is fresh before manual uploads).
    const invalidAbnFramePath = await captureHeroGif(browser, {
      basToken,
      basRequestId: basRequest.id,
      gifDir,
    });

    // Re-upload CSV + PDF to a fresh clean state? Note captureHeroGif approved CSV, so submit PDF + create clean view:
    // Re-seed a fresh BAS pack or simply reset DB for the 4 crisp static showcase screenshots.
    const detailRes = await apiJson(`${BASE_URL}/api/requests/${basRequest.id}`, {
      headers: { cookie: sessionCookie },
    });
    const detailData = await detailRes.json();
    const bankItem = detailData.items.find((i) => i.label.includes("Bank Statements"));
    const supplierItem = detailData.items.find((i) => i.label.includes("Missing Supplier Tax Invoices"));
    if (!bankItem || !supplierItem) {
      throw new Error("Expected BAS checklist items not found");
    }

    // Re-open CSV item back to submitted so static operator-review shows "Approve & next" on the CSV.
    db.prepare("UPDATE request_items SET status = 'submitted' WHERE id = ?").run(bankItem.id);

    // 1. Operator dashboard and ReviewSheet (1440x900)
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

    // 2. Client portal desktop
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

    // 3. Client portal mobile
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

    // 4. 1280x640 GitHub Social Preview & OpenGraph image
    const fontCss = loadFontFaceCss();
    const dashboardDataUrl = imgDataUrl(path.join(SCREENSHOTS_DIR, "operator-dashboard.png"));
    await renderHtmlCard(browser, {
      width: 1280,
      height: 640,
      html: buildSocialPreviewHtml(fontCss, dashboardDataUrl),
      outputPath: path.join(PUBLIC_DIR, "social-preview.png"),
    });

    // 5. Optional 5x Product Hunt gallery slides (1270x760) into LAUNCH_DIR
    if (LAUNCH_DIR) {
      fs.mkdirSync(LAUNCH_DIR, { recursive: true });
      const reviewDataUrl = imgDataUrl(path.join(SCREENSHOTS_DIR, "operator-review.png"));
      const desktopDataUrl = imgDataUrl(path.join(SCREENSHOTS_DIR, "client-portal-desktop.png"));
      const mobileDataUrl = imgDataUrl(path.join(SCREENSHOTS_DIR, "client-portal-mobile.png"));
      const abnDataUrl = imgDataUrl(invalidAbnFramePath);

      const slides = [
        {
          file: "01-hero-stop-chasing.png",
          kicker: "OPEN-SOURCE · MIT LICENCE · SELF-HOSTED",
          title: "Stop chasing clients for documents.",
          subtitle: "Collect files, validate structured data deterministically, and automate reminders in one container.",
          bodyHtml: `<div class="frame"><img src="${dashboardDataUrl}" alt="" /></div>`,
        },
        {
          file: "02-client-portal.png",
          kicker: "ZERO CLIENT PASSWORDS · WHITE-LABEL BRANDING",
          title: "A client portal calmer than email.",
          subtitle: "Magic links with optional 6-digit email OTP, instant auto-save, phone camera scan, and N/A notes.",
          bodyHtml: `<div class="frame"><img src="${desktopDataUrl}" alt="" /></div><div class="mobile-frame"><img src="${mobileDataUrl}" alt="" /></div>`,
        },
        {
          file: "03-deterministic-validation.png",
          kicker: "PLUGGABLE VALIDATOR PACKS + MAGIC-BYTE SNIFFING",
          title: "Catch bad checksums before they hit your queue.",
          subtitle: "Real file signatures (PDF, PNG, CSV, DOCX) and strict checksum packs (IBAN, E.164, ABN, BSB, TFN, Medicare).",
          bodyHtml: `<div class="frame"><img src="${abnDataUrl}" alt="" /></div>`,
        },
        {
          file: "04-keyboard-review.png",
          kicker: "CONTINUOUS REVIEW SHEET · J / K / SPACE / A / R",
          title: "Review 15 uploaded files in under 60 seconds.",
          subtitle: "Inline decrypted previews with Approve & next, one-click revision chips, and canonical ZIP export.",
          bodyHtml: `<div class="frame contain"><img src="${reviewDataUrl}" alt="" /></div>`,
        },
        {
          file: "05-self-hosted-vault.png",
          kicker: "ONE COMMAND TO LIVE WORKSPACE · ZERO TELEMETRY",
          title: "Your files stay encrypted on your server.",
          subtitle: "Per-record HKDF AES-256-GCM encryption, SQLite WAL, scheduled auto-purge, and signed HMAC webhooks.",
          bodyHtml: `<div style="flex:1;display:flex;flex-direction:column;gap:20px;">
            <div class="code-card">
              <div class="code-label">60-SECOND DOCKER QUICKSTART (AMD64 + ARM64)</div>
              <pre>docker run -d --name gathergate \\
  -p 127.0.0.1:3080:3080 \\
  -v gathergate_data:/data \\
  ghcr.io/faas19/gathergate:latest</pre>
            </div>
            <div class="specs">
              <div class="spec"><h3>AES-256-GCM Vault</h3><p>Every upload and sensitive field encrypted at rest with per-record derived keys.</p></div>
              <div class="spec"><h3>Scheduled Auto-Purge</h3><p>Sensitive packs shred automatically after retention windows (14d default for TFN/Medicare).</p></div>
              <div class="spec"><h3>MIT &amp; Zero Telemetry</h3><p>No phone-home analytics, no per-seat fees, and BYO S3, SMTP, or Resend when ready.</p></div>
            </div>
          </div>`,
        },
      ];

      for (const slide of slides) {
        await renderHtmlCard(browser, {
          width: 1270,
          height: 760,
          html: buildPhSlideHtml(fontCss, slide),
          outputPath: path.join(LAUNCH_DIR, slide.file),
        });
      }
      console.log(`Captured 5 Product Hunt gallery slides into ${LAUNCH_DIR}`);
    }

    console.log(`Captured 4 PNGs, hero-demo.gif, and social-preview.png into ${PUBLIC_DIR}`);
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (db) db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(gifDir, { recursive: true, force: true });
  }
}

await main();
