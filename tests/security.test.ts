import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { MemoryEmailAdapter } from "../src/adapters/email.js";
import { createStorageAdapter } from "../src/adapters/storage.js";
import { createApp, type RateLimitKey, type RateLimitRule } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { runReminderSweep } from "../src/jobs/chaser.js";
import { runPurgeSweep } from "../src/jobs/purge.js";
import { dispatchCompletionWebhook } from "../src/jobs/webhook.js";
import { createDecryptStream, decryptBuffer, encryptBuffer, hmacSha256Hex } from "../src/security/crypto.js";
import { extractClientIp } from "../src/security/rate-limit.js";

function extractCookie(setCookieHeader: string | null, name: string): string {
  assert.ok(setCookieHeader, `Expected Set-Cookie containing ${name}`);
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Cookie ${name} missing in ${setCookieHeader}`);
  return `${name}=${match[1]}`;
}

async function bootSecurityApp(options?: {
  multiTenant?: boolean;
  trustProxy?: boolean;
  rateLimits?: Partial<Record<RateLimitKey, RateLimitRule>>;
  fetchImpl?: typeof fetch;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-sec-"));
  let currentNow = Date.now();
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    BASE_URL: "http://localhost:3080",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
    MULTI_TENANT: options?.multiTenant ? "true" : "false",
    TRUST_PROXY: options?.trustProxy ? "true" : "false",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const storage = createStorageAdapter(config);
  const email = new MemoryEmailAdapter();
  const { app, store } = createApp({
    config,
    db,
    storage,
    email,
    fetchImpl: options?.fetchImpl,
    now: () => currentNow,
    rateLimits: options?.rateLimits,
  });

  return {
    tmpDir,
    config,
    db,
    storage,
    email,
    app,
    store,
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Security: cross-tenant IDOR fails closed across all operator endpoints", async () => {
  const ctx = await bootSecurityApp({ multiTenant: true });
  try {
    // 1. Unauthenticated access rejected with 401
    for (const url of ["/api/requests", "/api/clients", "/api/settings", "/api/templates", "/api/outbox"]) {
      const res = await ctx.app.request(url);
      assert.equal(res.status, 401, `Expected 401 for unauthenticated ${url}`);
    }

    // 2. Workspace A setup + seed webhook, branding, email config, template, request, TFN + file upload
    const setupA = await ctx.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Alpha Tax",
        email: "alpha@example.com",
        password: "alpha-secure-password",
        loadDemo: false,
      }),
    });
    assert.equal(setupA.status, 200);
    const cookieA = extractCookie(setupA.headers.get("set-cookie"), "gg_session");

    await ctx.app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ webhookUrl: "https://alpha.example.com/hook", webhookSecret: "whsec_alpha_secret" }),
    });
    await ctx.app.request("/api/settings/email", {
      method: "PUT",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({
        backend: "resend",
        from: "Alpha <portal@alpha.test>",
        resend: { apiKey: "re_alpha_secret_key" },
      }),
    });

    const tplARes = await ctx.app.request("/api/templates", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Alpha Private Template",
        items: [{ section: "ID", label: "TFN", kind: "text", required: true, validator: "au_tfn_mod11" }],
      }),
    });
    const tplA = ((await tplARes.json()) as { template: { id: string } }).template;

    const reqARes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Alpha Secret Request",
        clientName: "Alice A",
        clientEmail: "alice@alpha.test",
        sendInvite: false,
        items: [
          { section: "ID", label: "TFN", kind: "text", required: true, validator: "au_tfn_mod11" },
          { section: "Docs", label: "Bank PDF", kind: "file", required: true, allowedGroups: ["pdf"] },
        ],
      }),
    });
    assert.equal(reqARes.status, 201);
    const { id: idA, portalUrl: portalA } = (await reqARes.json()) as { id: string; portalUrl: string };
    const tokenA = portalA.split("/c/")[1];
    const detailA = (await (await ctx.app.request(`/api/requests/${idA}`, { headers: { cookie: cookieA } })).json()) as {
      items: Array<{ id: string; validator: string }>;
    };
    const tfnItemA = detailA.items.find((i) => i.validator === "au_tfn_mod11")!;
    const fileItemA = detailA.items.find((i) => i.validator === "none")!;

    await ctx.app.request(`/api/client/${tokenA}/items/${tfnItemA.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "876543210" }),
    });
    const pdfForm = new FormData();
    pdfForm.append("file", new File([Buffer.from("%PDF-1.4\n%ALPHA\n%%EOF\n")], "alpha.pdf", { type: "application/pdf" }));
    const upARes = await ctx.app.request(`/api/client/${tokenA}/items/${fileItemA.id}`, {
      method: "POST",
      body: pdfForm,
    });
    const uploadIdA = ((await upARes.json()) as { uploads: Array<{ id: string }> }).uploads[0].id;

    // 3. Workspace B signs up
    const signupB = await ctx.app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Beta Accounting",
        email: "beta@example.com",
        password: "beta-secure-password",
      }),
    });
    assert.equal(signupB.status, 200);
    const cookieB = extractCookie(signupB.headers.get("set-cookie"), "gg_session");

    // 4. Every cross-tenant access from Workspace B returns 404 or empty isolation
    const notFoundChecks: Array<[string, string, unknown?]> = [
      ["GET", `/api/requests/${idA}`],
      ["PATCH", `/api/requests/${idA}`, { dueAt: null }],
      ["POST", `/api/requests/${idA}/toggle-reminders`],
      ["POST", `/api/requests/${idA}/remind-now`],
      ["POST", `/api/requests/${idA}/items`, { label: "Injected", kind: "text" }],
      ["POST", `/api/requests/${idA}/items/${tfnItemA.id}/reveal`],
      ["POST", `/api/requests/${idA}/items/${tfnItemA.id}/review`, { decision: "approved" }],
      ["POST", `/api/requests/${idA}/approve-all-submitted`],
      ["GET", `/api/uploads/${uploadIdA}/preview`],
      ["GET", `/api/uploads/${uploadIdA}/download`],
      ["GET", `/api/requests/${idA}/export.zip`],
      ["PUT", `/api/templates/${tplA.id}`, { name: "Hijacked", items: [{ label: "X", kind: "text" }] }],
      ["DELETE", `/api/templates/${tplA.id}`],
      ["POST", `/api/templates/${tplA.id}/duplicate`],
    ];
    for (const [method, url, body] of notFoundChecks) {
      const res = await ctx.app.request(url, {
        method,
        headers: {
          cookie: cookieB,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      assert.equal(res.status, 404, `Expected 404 for IDOR ${method} ${url}`);
    }

    const listB = (await (await ctx.app.request("/api/requests", { headers: { cookie: cookieB } })).json()) as {
      requests: unknown[];
    };
    assert.equal(listB.requests.length, 0);

    const clientsB = (await (await ctx.app.request("/api/clients", { headers: { cookie: cookieB } })).json()) as {
      clients: unknown[];
    };
    assert.equal(clientsB.clients.length, 0);

    const outboxB = (await (await ctx.app.request("/api/outbox", { headers: { cookie: cookieB } })).json()) as {
      emails: unknown[];
    };
    assert.equal(outboxB.emails.length, 0);

    const bulkB = await ctx.app.request("/api/requests/bulk-reminders", {
      method: "POST",
      headers: { cookie: cookieB, "content-type": "application/json" },
      body: JSON.stringify({ ids: [idA], paused: true }),
    });
    assert.equal(bulkB.status, 200);
    assert.deepEqual(((await bulkB.json()) as { updatedIds: string[] }).updatedIds, []);
    const afterBulkA = ctx.store.getRequestById(ctx.store.getUserByEmail("alpha@example.com")!.workspace_id, idA)!;
    assert.equal(afterBulkA.reminders_paused, 0);

    const settingsBText = await (await ctx.app.request("/api/settings", { headers: { cookie: cookieB } })).text();
    assert.equal(settingsBText.includes("whsec_alpha_secret"), false);
    assert.equal(settingsBText.includes("alpha.example.com"), false);
    assert.equal(settingsBText.includes("re_alpha_secret_key"), false);
  } finally {
    ctx.cleanup();
  }
});

test("Security: OTP lockout after 5 attempts, expiry, replay blocking, and unauthenticated delete guard", async () => {
  const ctx = await bootSecurityApp();
  try {
    const setup = await ctx.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "OTP Firm",
        email: "ops@otp.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const opCookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");

    const createRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "OTP Protected",
        clientName: "Sam",
        clientEmail: "sam@otp.test",
        requireOtp: true,
        sendInvite: false,
        items: [{ label: "Receipt", kind: "file", required: true, allowedGroups: ["pdf"] }],
      }),
    });
    const { id: reqId, portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const token = portalUrl.split("/c/")[1];
    const item = ctx.store.listRequestItems(reqId)[0];

    // Send OTP #1
    assert.equal((await ctx.app.request(`/api/client/${token}/otp/send`, { method: "POST" })).status, 200);
    const code1 = ctx.email.sent[ctx.email.sent.length - 1].text.match(/\b(\d{6})\b/)![1];
    const wrongCode = code1 === "000000" ? "111111" : "000000";

    // 4 wrong attempts return 400; 5th returns 429; 6th with correct code still returns 429
    for (let i = 0; i < 4; i++) {
      const bad = await ctx.app.request(`/api/client/${token}/otp/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: wrongCode }),
      });
      assert.equal(bad.status, 400);
    }
    const fifth = await ctx.app.request(`/api/client/${token}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: wrongCode }),
    });
    assert.equal(fifth.status, 429);

    const sixthCorrect = await ctx.app.request(`/api/client/${token}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code1 }),
    });
    assert.equal(sixthCorrect.status, 429);

    // Send OTP #2 -> advance clock past 15-minute TTL -> correct code rejected as expired
    assert.equal((await ctx.app.request(`/api/client/${token}/otp/send`, { method: "POST" })).status, 200);
    const code2 = ctx.email.sent[ctx.email.sent.length - 1].text.match(/\b(\d{6})\b/)![1];
    ctx.advanceTime(16 * 60_000);
    const expiredVerify = await ctx.app.request(`/api/client/${token}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code2 }),
    });
    assert.equal(expiredVerify.status, 400);

    // Send OTP #3 -> verify succeeds -> replay same code fails
    assert.equal((await ctx.app.request(`/api/client/${token}/otp/send`, { method: "POST" })).status, 200);
    const code3 = ctx.email.sent[ctx.email.sent.length - 1].text.match(/\b(\d{6})\b/)![1];
    const okVerify = await ctx.app.request(`/api/client/${token}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code3 }),
    });
    assert.equal(okVerify.status, 200);
    const clientCookie = extractCookie(okVerify.headers.get("set-cookie"), `gg_c_${reqId}`);

    const replay = await ctx.app.request(`/api/client/${token}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code3 }),
    });
    assert.equal(replay.status, 400);

    // Upload a file with valid cookie, then verify unauthenticated caller cannot delete or write notes
    const form = new FormData();
    form.append("file", new File([Buffer.from("%PDF-1.4\n%OK\n%%EOF\n")], "ok.pdf", { type: "application/pdf" }));
    const upRes = await ctx.app.request(`/api/client/${token}/items/${item.id}`, {
      method: "POST",
      headers: { cookie: clientCookie },
      body: form,
    });
    assert.equal(upRes.status, 200);
    const uploadId = ((await upRes.json()) as { uploads: Array<{ id: string }> }).uploads[0].id;

    const unauthNote = await ctx.app.request(`/api/client/${token}/items/${item.id}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "snooped" }),
    });
    assert.equal(unauthNote.status, 401);

    const unauthDel = await ctx.app.request(`/api/client/${token}/uploads/${uploadId}`, {
      method: "DELETE",
    });
    assert.equal(unauthDel.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test("Security: per-IP and per-token 429 rate limiting with Retry-After across OTP, uploads, and login", async () => {
  const ctx = await bootSecurityApp({
    trustProxy: true,
    rateLimits: {
      otpSendToken: { limit: 2, windowMs: 60_000 },
      otpSendIp: { limit: 3, windowMs: 60_000 },
      otpVerifyToken: { limit: 2, windowMs: 60_000 },
      otpVerifyIp: { limit: 3, windowMs: 60_000 },
      uploadToken: { limit: 2, windowMs: 60_000 },
      uploadIp: { limit: 3, windowMs: 60_000 },
      loginIp: { limit: 2, windowMs: 60_000 },
    },
  });
  try {
    const setup = await ctx.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "RateLimit Co",
        email: "ops@rate.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const opCookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");

    const createReq = async (otp: boolean) => {
      const r = await ctx.app.request("/api/requests", {
        method: "POST",
        headers: { cookie: opCookie, "content-type": "application/json" },
        body: JSON.stringify({
          title: otp ? "OTP Req" : "Upload Req",
          clientName: "C",
          clientEmail: "c@rate.test",
          requireOtp: otp,
          sendInvite: false,
          items: [{ label: "PDF", kind: "file", required: true, allowedGroups: ["pdf"] }],
        }),
      });
      return (await r.json()) as { id: string; portalUrl: string };
    };

    const req1 = await createReq(true);
    const req2 = await createReq(true);
    const tok1 = req1.portalUrl.split("/c/")[1];
    const tok2 = req2.portalUrl.split("/c/")[1];

    // 1. OTP Send: per-token limit (2) trips on 3rd call, including from a second IP
    assert.equal(
      (await ctx.app.request(`/api/client/${tok1}/otp/send`, { method: "POST", headers: { "x-forwarded-for": "1.1.1.1" } })).status,
      200
    );
    assert.equal(
      (await ctx.app.request(`/api/client/${tok1}/otp/send`, { method: "POST", headers: { "x-forwarded-for": "1.1.1.1" } })).status,
      200
    );
    const tokLimited = await ctx.app.request(`/api/client/${tok1}/otp/send`, {
      method: "POST",
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    assert.equal(tokLimited.status, 429);
    assert.ok(Number(tokLimited.headers.get("retry-after")) >= 1);

    // Per-IP limit (3) on 1.1.1.1: 3rd request passes on tok2, 4th trips 429 even on fresh tok2
    assert.equal(
      (await ctx.app.request(`/api/client/${tok2}/otp/send`, { method: "POST", headers: { "x-forwarded-for": "1.1.1.1" } })).status,
      200
    );
    const ipLimited = await ctx.app.request(`/api/client/${tok2}/otp/send`, {
      method: "POST",
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    assert.equal(ipLimited.status, 429);

    // 2. OTP Verify: per-token limit (2) trips on 3rd call with Retry-After
    assert.equal(
      (
        await ctx.app.request(`/api/client/${tok1}/otp/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "3.3.3.3" },
          body: JSON.stringify({ code: "000000" }),
        })
      ).status,
      400
    );
    assert.equal(
      (
        await ctx.app.request(`/api/client/${tok1}/otp/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "3.3.3.3" },
          body: JSON.stringify({ code: "000000" }),
        })
      ).status,
      400
    );
    const verifyLimited = await ctx.app.request(`/api/client/${tok1}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "4.4.4.4" },
      body: JSON.stringify({ code: "000000" }),
    });
    assert.equal(verifyLimited.status, 429);
    assert.ok(Number(verifyLimited.headers.get("retry-after")) >= 1);

    // 3. Upload rate limit (2 per token)
    const upReq = await createReq(false);
    const upTok = upReq.portalUrl.split("/c/")[1];
    const upItem = ctx.store.listRequestItems(upReq.id)[0];
    const sendPdf = (ip: string) => {
      const f = new FormData();
      f.append("file", new File([Buffer.from("%PDF-1.4\n%RL\n%%EOF\n")], "r.pdf", { type: "application/pdf" }));
      return ctx.app.request(`/api/client/${upTok}/items/${upItem.id}`, {
        method: "POST",
        headers: { "x-forwarded-for": ip },
        body: f,
      });
    };
    assert.equal((await sendPdf("5.5.5.5")).status, 200);
    assert.equal((await sendPdf("5.5.5.5")).status, 200);
    const upLimited = await sendPdf("6.6.6.6");
    assert.equal(upLimited.status, 429);
    assert.ok(Number(upLimited.headers.get("retry-after")) >= 1);

    // 4. Login IP rate limit (2 per IP) + isolation + window reset
    const loginAttempt = (ip: string) =>
      ctx.app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ email: "ops@rate.test", password: "wrong-password" }),
      });
    assert.equal((await loginAttempt("7.7.7.7")).status, 401);
    assert.equal((await loginAttempt("7.7.7.7")).status, 401);
    const loginLimited = await loginAttempt("7.7.7.7");
    assert.equal(loginLimited.status, 429);
    assert.equal((await loginAttempt("8.8.8.8")).status, 401);

    ctx.advanceTime(61_000);
    assert.equal((await loginAttempt("7.7.7.7")).status, 401);
    assert.equal((await sendPdf("6.6.6.6")).status, 200);
  } finally {
    ctx.cleanup();
  }
});

test("Security: blocks spoofed magic-bytes, polyglot/oversized/mismatched files, SVG logos, and malformed uploads", async () => {
  const ctx = await bootSecurityApp();
  try {
    const setup = await ctx.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Sniff Safe",
        email: "ops@sniff.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const opCookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");

    // SVG logo rejected on branding endpoint
    const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    const svgRes = await ctx.app.request("/api/settings/branding", {
      method: "PUT",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({ logoDataUrl: `data:image/svg+xml;base64,${svgB64}` }),
    });
    assert.equal(svgRes.status, 400);

    const createRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Upload Validation",
        clientName: "Client",
        clientEmail: "client@sniff.test",
        sendInvite: false,
        items: [
          { label: "Any Safe 1MB", kind: "file", required: true, allowedGroups: ["any_safe"], maxFileMb: 1 },
          { label: "PDF Only", kind: "file", required: false, allowedGroups: ["pdf"], maxFileMb: 1 },
        ],
      }),
    });
    const { id: reqId, portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const token = portalUrl.split("/c/")[1];
    const [anyItem, pdfOnlyItem] = ctx.store.listRequestItems(reqId);

    const uploadFile = (itemId: string, bytes: Buffer, name: string, mime: string) => {
      const f = new FormData();
      f.append("file", new File([new Uint8Array(bytes)], name, { type: mime }));
      return ctx.app.request(`/api/client/${token}/items/${itemId}`, { method: "POST", body: f });
    };

    const badPayloads: Array<[Buffer, string, string]> = [
      [Buffer.from("MZ\x90\x00\x03\x00evil"), "invoice.pdf", "application/pdf"],
      [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), "scan.png", "image/png"],
      [Buffer.from("#!/bin/sh\nid\n"), "notes.txt", "text/plain"],
      [Buffer.from("<script>alert(1)</script>\n"), "sheet.csv", "text/csv"],
      [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00]), "archive.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      [Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024 * 1024 + 32, 0x41)]), "huge.pdf", "application/pdf"],
    ];

    for (const [buf, name, mime] of badPayloads) {
      const res = await uploadFile(anyItem.id, buf, name, mime);
      assert.equal(res.status, 400, `Expected 400 rejecting ${name}`);
    }

    // Valid PNG on PDF-only item fails group allow-list
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.equal((await uploadFile(pdfOnlyItem.id, pngBytes, "pic.png", "image/png")).status, 400);

    // Malformed non-multipart payload returns clean 400 (never 500)
    const malformed = await ctx.app.request(`/api/client/${token}/items/${anyItem.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "multipart" }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test("Security: expired/purged token rejection and HMAC webhook verification", async () => {
  const webhooks: Array<{ headers: Record<string, string>; body: string }> = [];
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    webhooks.push({
      headers: (init?.headers as Record<string, string>) || {},
      body: String(init?.body || ""),
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const ctx = await bootSecurityApp({ fetchImpl: mockFetch });
  try {
    const setup = await ctx.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Webhook Firm",
        email: "ops@wh.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const opCookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");
    const whSecret = "whsec_verify_hmac_123";
    await ctx.app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({ webhookUrl: "https://hook.example.com/in", webhookSecret: whSecret }),
    });

    // Request 1: expired status checks
    const rExpRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Expired Check",
        clientName: "Expired User",
        clientEmail: "exp@wh.test",
        requireOtp: true,
        sendInvite: false,
        items: [
          { label: "File", kind: "file", required: true, allowedGroups: ["pdf"] },
          { label: "Email", kind: "text", required: true, validator: "email" },
        ],
      }),
    });
    const { id: expId, portalUrl: expUrl } = (await rExpRes.json()) as { id: string; portalUrl: string };
    const expToken = expUrl.split("/c/")[1];
    const [expFileItem, expTextItem] = ctx.store.listRequestItems(expId);

    ctx.db.prepare("UPDATE requests SET status = 'expired' WHERE id = ?").run(expId);
    assert.equal((await ctx.app.request(`/api/client/${expToken}`)).status, 410);
    assert.equal((await ctx.app.request(`/api/client/${expToken}/otp/send`, { method: "POST" })).status, 404);
    assert.equal(
      (
        await ctx.app.request(`/api/client/${expToken}/otp/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "123456" }),
        })
      ).status,
      404
    );
    assert.equal(
      (
        await ctx.app.request(`/api/client/${expToken}/items/${expTextItem.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "a@b.com" }),
        })
      ).status,
      403
    );
    assert.equal(
      (
        await ctx.app.request(`/api/client/${expToken}/items/${expFileItem.id}/note`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "note" }),
        })
      ).status,
      403
    );
    assert.equal((await ctx.app.request(`/api/client/${expToken}/uploads/upl_none`, { method: "DELETE" })).status, 403);

    // Request 2: completion HMAC webhook + purge rejection
    const rCompRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Tax Complete",
        clientName: "Tax User",
        clientEmail: "tax@wh.test",
        sendInvite: false,
        items: [{ label: "TFN", kind: "text", required: true, validator: "au_tfn_mod11" }],
      }),
    });
    const { id: compId, portalUrl: compUrl } = (await rCompRes.json()) as { id: string; portalUrl: string };
    const compToken = compUrl.split("/c/")[1];
    const tfnItem = ctx.store.listRequestItems(compId)[0];

    await ctx.app.request(`/api/client/${compToken}/items/${tfnItem.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "876543210" }),
    });
    const noteRes = await ctx.app.request(`/api/client/${compToken}/items/${tfnItem.id}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "Sensitive note to shred on purge" }),
    });
    assert.equal(noteRes.status, 200);
    await ctx.app.request(`/api/requests/${compId}/approve-all-submitted`, {
      method: "POST",
      headers: { cookie: opCookie },
    });

    assert.equal(webhooks.length, 1);
    assert.match(webhooks[0].headers["user-agent"] || "", /^GatherGate\/1\.0\b/);
    const sigHeader = webhooks[0].headers["x-gathergate-signature"];
    const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    assert.ok(m, `Unexpected signature header: ${sigHeader}`);
    assert.equal(m[2], hmacSha256Hex(whSecret, `${m[1]}.${webhooks[0].body}`));
    assert.notEqual(m[2], hmacSha256Hex(whSecret, `${m[1]}.${webhooks[0].body} `));
    assert.equal(webhooks[0].body.includes("876 543 210"), false);
    assert.equal(webhooks[0].body.includes("****** 210"), true);

    await runPurgeSweep({
      store: ctx.store,
      storage: ctx.storage,
      nowIso: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
    const purgedItem = ctx.store.getRequestItem(compId, tfnItem.id)!;
    assert.equal(purgedItem.value_encrypted, null);
    assert.equal(purgedItem.client_note_encrypted, null);
    assert.equal(
      (ctx.db.prepare("SELECT COUNT(*) as c FROM outbox_emails WHERE request_id = ?").get(compId) as { c: number }).c,
      0
    );
    assert.equal(
      (ctx.db.prepare("SELECT COUNT(*) as c FROM otp_codes WHERE request_id = ?").get(compId) as { c: number }).c,
      0
    );
    assert.equal(
      (ctx.db.prepare("SELECT COUNT(*) as c FROM client_sessions WHERE request_id = ?").get(compId) as { c: number }).c,
      0
    );
    const purgedReqRow = ctx.db.prepare("SELECT token_encrypted FROM requests WHERE id = ?").get(compId) as {
      token_encrypted: string;
    };
    assert.equal(purgedReqRow.token_encrypted, "");

    const purgedPortal = await ctx.app.request(`/api/client/${compToken}`);
    assert.equal(purgedPortal.status, 200);
    const purgedJson = (await purgedPortal.json()) as {
      request: { status: string; client_name?: string; due_at?: string };
      items: unknown[];
    };
    assert.equal(purgedJson.request.status, "purged");
    assert.equal(purgedJson.request.client_name, undefined);
    assert.equal(purgedJson.request.due_at, undefined);
    assert.deepEqual(purgedJson.items, []);
    assert.equal((await ctx.app.request(`/api/client/${compToken}/otp/send`, { method: "POST" })).status, 404);
    assert.equal((await ctx.app.request(`/api/requests/${compId}/export.zip`, { headers: { cookie: opCookie } })).status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("Security: 14-day default purge on sensitive packs, blob enc_version fail-closed, and zero-config MASTER_KEY", async () => {
  const ctx = await bootSecurityApp();
  const prodDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-prodkey-"));
  try {
    const setup = await ctx.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Retention Firm",
        email: "ops@ret.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const opCookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");

    const createWithValidator = async (validator: string, explicitPurge?: number) => {
      const r = await ctx.app.request("/api/requests", {
        method: "POST",
        headers: { cookie: opCookie, "content-type": "application/json" },
        body: JSON.stringify({
          title: `Pack ${validator}`,
          clientName: "C",
          clientEmail: "c@ret.test",
          sendInvite: false,
          ...(explicitPurge !== undefined ? { purgeAfterDays: explicitPurge } : {}),
          items: [{ label: "Field", kind: "text", required: true, validator }],
        }),
      });
      return ((await r.json()) as { id: string }).id;
    };

    const tfnReq = ctx.store.getRequestById(ctx.store.getUserByEmail("ops@ret.test")!.workspace_id, await createWithValidator("au_tfn_mod11"))!;
    const medReq = ctx.store.getRequestById(ctx.store.getUserByEmail("ops@ret.test")!.workspace_id, await createWithValidator("au_medicare_mod10"))!;
    const abnReq = ctx.store.getRequestById(ctx.store.getUserByEmail("ops@ret.test")!.workspace_id, await createWithValidator("au_abn_mod89"))!;
    const customReq = ctx.store.getRequestById(ctx.store.getUserByEmail("ops@ret.test")!.workspace_id, await createWithValidator("au_tfn_mod11", 7))!;

    assert.equal(tfnReq.purge_after_days, 14);
    assert.equal(medReq.purge_after_days, 14);
    assert.equal(abnReq.purge_after_days, 30);
    assert.equal(customReq.purge_after_days, 7);

    // Unknown encryption version fails closed
    const key = crypto.randomBytes(32);
    const { ciphertext, meta } = encryptBuffer(key, Buffer.from("secret"), "aad");
    assert.equal(meta.version, "v1");
    await assert.rejects(() => decryptBuffer(key, ciphertext, { ...meta, version: "v99" }, "aad"), /Unsupported encryption version/);
    assert.throws(
      () => createDecryptStream(key, Readable.from([ciphertext]), { ...meta, version: "v99" }, "aad"),
      /Unsupported encryption version/
    );

    // Zero-config production MASTER_KEY generation, persistence, and session readiness flag
    const cfg1 = loadConfig({ NODE_ENV: "production", DATA_DIR: prodDataDir });
    assert.equal(cfg1.masterKeySource, "file");
    assert.equal(cfg1.masterKey.byteLength, 32);
    assert.equal(fs.existsSync(path.join(prodDataDir, ".master.key")), true);

    const cfg2 = loadConfig({ NODE_ENV: "production", DATA_DIR: prodDataDir });
    assert.equal(cfg2.masterKeySource, "file");
    assert.deepEqual(cfg2.masterKey, cfg1.masterKey);

    const dbProd = openDatabase(path.join(prodDataDir, "prod.sqlite"));
    const { app: prodApp } = createApp({
      config: cfg1,
      db: dbProd,
      storage: createStorageAdapter(cfg1),
      email: new MemoryEmailAdapter(),
    });
    const anonSess = (await (await prodApp.request("/api/session")).json()) as {
      readiness: { masterKeyAutoGenerated: boolean };
    };
    assert.equal(anonSess.readiness.masterKeyAutoGenerated, false);

    const prodSetup = await prodApp.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Zero Config",
        email: "ops@zero.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const prodCookie = extractCookie(prodSetup.headers.get("set-cookie"), "gg_session");
    const authedSess = (await (
      await prodApp.request("/api/session", { headers: { cookie: prodCookie } })
    ).json()) as { readiness: { masterKeyAutoGenerated: boolean } };
    assert.equal(authedSess.readiness.masterKeyAutoGenerated, true);
    dbProd.close();

    fs.writeFileSync(path.join(prodDataDir, ".master.key"), "not-valid-hex\n");
    assert.throws(() => loadConfig({ NODE_ENV: "production", DATA_DIR: prodDataDir }), /Invalid MASTER_KEY file/);
  } finally {
    ctx.cleanup();
    fs.rmSync(prodDataDir, { recursive: true, force: true });
  }
});

test("Security: multi-tenant webhook rejects private/loopback/link-local targets while self-hosted allows local", async () => {
  const mt = await bootSecurityApp({ multiTenant: true });
  const sh = await bootSecurityApp({ multiTenant: false });
  try {
    const mtReg = await mt.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Tenant A",
        email: "ops@tenanta.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const mtCookie = extractCookie(mtReg.headers.get("set-cookie"), "gg_session");

    for (const badUrl of [
      "http://hooks.example.com/in",
      "http://127.0.0.1:5678/hook",
      "http://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://localhost/hook",
      "https://10.0.0.5/hook",
    ]) {
      const res = await mt.app.request("/api/settings/webhook", {
        method: "PUT",
        headers: { cookie: mtCookie, "content-type": "application/json" },
        body: JSON.stringify({ webhookUrl: badUrl, webhookSecret: "whsec_test" }),
      });
      assert.equal(res.status, 400, `Expected 400 in multi-tenant mode for ${badUrl}`);
    }

    const okMt = await mt.app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: mtCookie, "content-type": "application/json" },
      body: JSON.stringify({ webhookUrl: "https://hooks.example.com/in", webhookSecret: "whsec_test" }),
    });
    assert.equal(okMt.status, 200);

    const shSetup = await sh.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Local n8n Firm",
        email: "ops@local.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    const shCookie = extractCookie(shSetup.headers.get("set-cookie"), "gg_session");
    const okSh = await sh.app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: shCookie, "content-type": "application/json" },
      body: JSON.stringify({ webhookUrl: "http://127.0.0.1:5678/webhook/gathergate", webhookSecret: "whsec_local" }),
    });
    assert.equal(okSh.status, 200);

    // Multi-tenant rejects single-label internal hostnames (e.g. redis)
    const badSingleLabel = await mt.app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: mtCookie, "content-type": "application/json" },
      body: JSON.stringify({ webhookUrl: "https://redis/hook", webhookSecret: "whsec_test" }),
    });
    assert.equal(badSingleLabel.status, 400);

    // Runtime dispatch enforces redirect: "error" and blocks hostnames resolving to loopback via DNS
    const mtSetupReq = await mt.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: mtCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "SSRF Dispatch Test",
        clientName: "SSRF Client",
        clientEmail: "ssrf@example.com",
        sendInvite: false,
        items: [{ label: "Email", kind: "text", required: true, validator: "email" }],
      }),
    });
    assert.equal(mtSetupReq.status, 201);
    const { id: mtReqId } = (await mtSetupReq.json()) as { id: string };
    const mtWsId = (mt.db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
    const wsMt = mt.store.getWorkspaceById(mtWsId)!;
    const reqMt = mt.store.getRequestById(mtWsId, mtReqId)!;
    let fetchCalled = false;
    const dnsBlocked = await dispatchCompletionWebhook({
      store: mt.store,
      workspace: { ...wsMt, webhook_url: "https://rebind.example.com/hook" },
      request: reqMt,
      masterKey: mt.config.masterKey,
      baseUrl: mt.config.baseUrl,
      multiTenant: true,
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(dnsBlocked.dispatched, false);
    assert.equal(fetchCalled, false);

    let capturedRedirect: RequestRedirect | undefined;
    const pubDispatched = await dispatchCompletionWebhook({
      store: mt.store,
      workspace: { ...wsMt, webhook_url: "https://hooks.example.com/in" },
      request: reqMt,
      masterKey: mt.config.masterKey,
      baseUrl: mt.config.baseUrl,
      multiTenant: true,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: (async (_url, init) => {
        capturedRedirect = init?.redirect;
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(pubDispatched.dispatched, true);
    assert.equal(capturedRedirect, "error");
  } finally {
    mt.cleanup();
    sh.cleanup();
  }
});

test("Security: trustProxy IP extraction, optional-item state gating, corrupt blob 500s, single-file replace, and cron isolation", async () => {
  const unproxied = await bootSecurityApp({
    multiTenant: true,
    trustProxy: false,
    rateLimits: {
      loginIp: { limit: 2, windowMs: 60_000 },
      signupIp: { limit: 2, windowMs: 60_000 },
    },
  });
  const proxied = await bootSecurityApp({
    trustProxy: true,
    rateLimits: { loginIp: { limit: 2, windowMs: 60_000 } },
  });

  try {
    // 1. trustProxy=false ignores spoofed X-Forwarded-For & CF-Connecting-IP headers
    for (const fakeIp of ["1.1.1.1", "2.2.2.2"]) {
      const res = await unproxied.app.request("/api/signup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": fakeIp,
          "cf-connecting-ip": fakeIp,
        },
        body: JSON.stringify({
          workspaceName: `Firm ${fakeIp}`,
          email: `ops-${fakeIp}@example.com`,
          password: "correct-horse-battery",
        }),
      });
      assert.equal(res.status, 200);
    }
    const thirdSignup = await unproxied.app.request("/api/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "9.9.9.9",
        "cf-connecting-ip": "8.8.8.8",
      },
      body: JSON.stringify({
        workspaceName: "Firm 3",
        email: "ops-3@example.com",
        password: "correct-horse-battery",
      }),
    });
    assert.equal(thirdSignup.status, 429);

    // trustProxy=true takes rightmost X-Forwarded-For entry; trustProxy=false ignores XFF
    const ipProbe = new Hono();
    ipProbe.get("/trusted", (c) => c.text(extractClientIp(c, true)));
    ipProbe.get("/untrusted", (c) => c.text(extractClientIp(c, false)));
    assert.equal(
      await (await ipProbe.request("/trusted", { headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.22" } })).text(),
      "198.51.100.22"
    );
    assert.equal(
      await (await ipProbe.request("/untrusted", { headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.22" } })).text(),
      "unknown"
    );

    // 2. Optional item gating, reopen clearing purge_at, single-file replacement, and corrupt blob handling
    const setup = await proxied.app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Hardening Vault",
        email: "ops@hardening.test",
        password: "correct-horse-battery",
        loadDemo: false,
      }),
    });
    assert.equal(setup.status, 200);
    const cookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");
    const proxiedWsId = (proxied.db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;

    const createRes = await proxied.app.request("/api/requests", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Optional Gating Pack",
        clientName: "Alice",
        clientEmail: "alice@example.com",
        sendInvite: false,
        items: [
          { label: "Required Email", kind: "text", required: true, validator: "email" },
          { label: "Optional File", kind: "file", required: false, multiple: false, allowedGroups: ["pdf"] },
        ],
      }),
    });
    const { id: reqId, portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const token = portalUrl.split("/c/")[1];
    const items = proxied.store.listRequestItems(reqId);
    const reqEmailItem = items.find((i) => i.required === 1)!;
    const optFileItem = items.find((i) => i.required === 0)!;

    await proxied.app.request(`/api/client/${token}/items/${reqEmailItem.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "alice@example.com" }),
    });

    // Reject multi-file batch on multiple:false item
    const twoPdf = new FormData();
    twoPdf.append("file", new File([Buffer.from("%PDF-1.4\n%%EOF\n")], "a.pdf", { type: "application/pdf" }));
    twoPdf.append("file", new File([Buffer.from("%PDF-1.4\n%%EOF\n")], "b.pdf", { type: "application/pdf" }));
    assert.equal(
      (await proxied.app.request(`/api/client/${token}/items/${optFileItem.id}`, { method: "POST", body: twoPdf })).status,
      400
    );

    // Upload 1st PDF then replace with 2nd PDF (single upload remains)
    for (const name of ["first.pdf", "second.pdf"]) {
      const fd = new FormData();
      fd.append("file", new File([Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`)], name, { type: "application/pdf" }));
      assert.equal(
        (await proxied.app.request(`/api/client/${token}/items/${optFileItem.id}`, { method: "POST", body: fd })).status,
        200
      );
    }
    const uploadsAfterReplace = proxied.store.listUploadsForRequest(reqId);
    assert.equal(uploadsAfterReplace.length, 1);
    assert.equal(uploadsAfterReplace[0].original_name, "second.pdf");

    // Approve required item while optional file is still submitted -> request stays in_review (not completed)
    const partialApprove = await proxied.app.request(`/api/requests/${reqId}/items/${reqEmailItem.id}/review`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(partialApprove.status, 200);
    assert.equal(((await partialApprove.json()) as { status: string }).status, "in_review");

    // Reject optional file -> request is open (not completed)
    const optReject = await proxied.app.request(`/api/requests/${reqId}/items/${optFileItem.id}/review`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected", note: "Blurry scan" }),
    });
    assert.equal(optReject.status, 200);
    assert.equal(((await optReject.json()) as { status: string }).status, "open");

    // Complete cleanly then reopen -> clears purge_at and excludes from listPurgeDueRequests
    assert.equal(
      (
        await proxied.app.request(`/api/requests/${reqId}/items/${optFileItem.id}/review`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        })
      ).status,
      200
    );
    assert.ok(proxied.store.getRequestById(proxiedWsId, reqId)!.purge_at);
    assert.equal(
      (
        await proxied.app.request(`/api/requests/${reqId}/items/${reqEmailItem.id}/review`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ decision: "rejected", note: "Need update" }),
        })
      ).status,
      200
    );
    const reopened = proxied.store.getRequestById(proxiedWsId, reqId)!;
    assert.equal(reopened.status, "open");
    assert.equal(reopened.purge_at, null);
    assert.equal(reopened.completed_at, null);
    assert.equal(
      proxied.store.listPurgeDueRequests(new Date(Date.now() + 90 * 86400_000).toISOString()).length,
      0
    );

    // Corrupt encrypted blob on disk -> clean HTTP 500 JSON (never crashes / never 200)
    const upl = uploadsAfterReplace[0];
    const blobPath = path.join(proxied.tmpDir, "blobs", upl.storage_key);
    const rawBlob = fs.readFileSync(blobPath);
    rawBlob[rawBlob.length - 1] ^= 0xff;
    fs.writeFileSync(blobPath, rawBlob);

    assert.equal((await proxied.app.request(`/api/uploads/${upl.id}/preview`, { headers: { cookie } })).status, 500);
    assert.equal((await proxied.app.request(`/api/uploads/${upl.id}/download`, { headers: { cookie } })).status, 500);
    assert.equal((await proxied.app.request(`/api/requests/${reqId}/export.zip`, { headers: { cookie } })).status, 500);

    // 3. Cron reminder sweep skips is_demo=1 and isolates throwing email sends
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    const mkCronReq = async (clientEmail: string, isDemo: boolean) => {
      const r = await proxied.app.request("/api/requests", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          title: `Cron ${clientEmail}`,
          clientName: "Cron Client",
          clientEmail,
          sendInvite: false,
          items: [{ label: "Email", kind: "text", required: true, validator: "email" }],
        }),
      });
      const { id } = (await r.json()) as { id: string };
      proxied.db
        .prepare("UPDATE requests SET next_reminder_at = ?, is_demo = ? WHERE id = ?")
        .run(pastIso, isDemo ? 1 : 0, id);
      return id;
    };
    const demoReqId = await mkCronReq("demo-skip@example.com", true);
    const failReqId = await mkCronReq("fail-send@example.com", false);
    const okReqId = await mkCronReq("ok-send@example.com", false);

    const sentRecipients: string[] = [];
    const sentCount = await runReminderSweep({
      store: proxied.store,
      email: {
        async send(msg) {
          if (msg.to === "fail-send@example.com") {
            throw new Error("Transient SMTP error");
          }
          sentRecipients.push(msg.to);
        },
      },
      baseUrl: proxied.config.baseUrl,
      masterKey: proxied.config.masterKey,
    });
    assert.equal(sentCount, 1);
    assert.deepEqual(sentRecipients, ["ok-send@example.com"]);
    assert.equal(proxied.store.getRequestById(proxiedWsId, demoReqId)!.reminders_sent, 0);
    assert.equal(proxied.store.getRequestById(proxiedWsId, failReqId)!.reminders_sent, 0);
    assert.ok(
      proxied.store.listAuditEvents(failReqId).some((e) => e.action === "reminder.failed")
    );
    assert.equal(proxied.store.getRequestById(proxiedWsId, okReqId)!.reminders_sent, 1);
  } finally {
    unproxied.cleanup();
    proxied.cleanup();
  }
});

test("Security: pre-launch hardening (SMTP DNS SSRF, atomic batch upload rollback, encrypted webhook secret, non-OTP guard, sanitized detail)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-harden-"));
  try {
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: tmpDir,
      MASTER_KEY: crypto.randomBytes(32).toString("hex"),
      BASE_URL: "http://localhost:3080",
      EMAIL_BACKEND: "console",
      STORAGE_BACKEND: "local",
      MULTI_TENANT: "true",
    });
    const db = openDatabase(path.join(tmpDir, "test.sqlite"));
    const baseStorage = createStorageAdapter(config);
    let failOnPutNumber = 0;
    let putCount = 0;
    const flakyStorage = {
      async put(key: string, data: Buffer) {
        putCount += 1;
        if (failOnPutNumber > 0 && putCount === failOnPutNumber) {
          throw new Error("Simulated storage write failure");
        }
        return baseStorage.put(key, data);
      },
      getStream: (key: string) => baseStorage.getStream(key),
      delete: (key: string) => baseStorage.delete(key),
    };
    const email = new MemoryEmailAdapter();
    const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    const { app, store } = createApp({
      config,
      db,
      storage: flakyStorage,
      email,
      lookupImpl: privateLookup,
    });

    try {
      const setup = await app.request("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceName: "Hardened Practice",
          email: "ops@harden.test",
          password: "correct-horse-battery",
          loadDemo: false,
        }),
      });
      assert.equal(setup.status, 200);
      const cookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");
      const wsId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;

      // 1. Webhook secret is encrypted at rest in SQLite, decrypted on GET /api/settings
      const whSave = await app.request("/api/settings/webhook", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          webhookUrl: "https://hooks.example.com/in",
          webhookSecret: "whsec_encrypted_at_rest_123",
        }),
      });
      assert.equal(whSave.status, 200);
      const rawWhRow = db.prepare("SELECT webhook_secret FROM workspaces WHERE id = ?").get(wsId) as {
        webhook_secret: string;
      };
      assert.ok(rawWhRow.webhook_secret.startsWith("v1:"), "webhook_secret must be AES-GCM encrypted in SQLite");
      assert.equal(rawWhRow.webhook_secret.includes("whsec_encrypted_at_rest_123"), false);
      const getSettings = (await (
        await app.request("/api/settings", { headers: { cookie } })
      ).json()) as { webhookSecret: string };
      assert.equal(getSettings.webhookSecret, "whsec_encrypted_at_rest_123");

      // 2. Multi-tenant SMTP DNS rebinding SSRF blocked on request invite AND cron reminder sweep
      const smtpSave = await app.request("/api/settings/email", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          backend: "smtp",
          from: "Practice <mail@harden.example.com>",
          smtp: { host: "rebind.example.com", port: 587, secure: false, user: "u", pass: "p" },
        }),
      });
      assert.equal(smtpSave.status, 200);

      const reqCreate = await app.request("/api/requests", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          title: "SSRF Email Check",
          clientName: "Client One",
          clientEmail: "client@harden.test",
          requireOtp: false,
          sendInvite: true,
          items: [{ label: "Docs", kind: "file", required: true, multiple: true, allowedGroups: ["pdf"] }],
        }),
      });
      assert.equal(reqCreate.status, 201);
      const createdJson = (await reqCreate.json()) as { id: string; portalUrl: string; inviteError?: string };
      assert.ok(createdJson.inviteError, "Blocked SMTP SSRF should report inviteError without 500 crash");
      assert.ok(
        store.listAuditEvents(createdJson.id).some((e) => e.action === "invite.failed"),
        "Blocked invite email must be recorded in audit_events"
      );

      db.prepare("UPDATE requests SET next_reminder_at = ? WHERE id = ?").run(
        new Date(Date.now() - 60_000).toISOString(),
        createdJson.id
      );
      const cronSent = await runReminderSweep({
        store,
        email,
        baseUrl: config.baseUrl,
        masterKey: config.masterKey,
        config,
        lookupImpl: privateLookup,
      });
      assert.equal(cronSent, 0);
      assert.ok(
        store.listAuditEvents(createdJson.id).some((e) => e.action === "reminder.failed"),
        "Cron SMTP SSRF block must log reminder.failed"
      );

      // 3. GET /api/requests/:id omits internal token_hash and token_encrypted
      const detailRes = await app.request(`/api/requests/${createdJson.id}`, { headers: { cookie } });
      assert.equal(detailRes.status, 200);
      const detailJson = (await detailRes.json()) as {
        request: Record<string, unknown>;
        items: Array<{ id: string }>;
      };
      assert.equal("token_hash" in detailJson.request, false);
      assert.equal("token_encrypted" in detailJson.request, false);

      // 4. Non-OTP checklist rejects /otp/send and /otp/verify with 400
      const token = createdJson.portalUrl.split("/c/")[1];
      assert.equal((await app.request(`/api/client/${token}/otp/send`, { method: "POST" })).status, 400);
      assert.equal(
        (
          await app.request(`/api/client/${token}/otp/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "123456" }),
          })
        ).status,
        400
      );

      // 5. Partial multi-file upload failure leaves zero dangling SQLite rows and zero blobs
      const fileItemId = detailJson.items[0].id;
      failOnPutNumber = 2;
      putCount = 0;
      const fd = new FormData();
      fd.append("file", new File([Buffer.from("%PDF-1.4\n%1\n%%EOF\n")], "one.pdf", { type: "application/pdf" }));
      fd.append("file", new File([Buffer.from("%PDF-1.4\n%2\n%%EOF\n")], "two.pdf", { type: "application/pdf" }));
      const failedBatch = await app.request(`/api/client/${token}/items/${fileItemId}`, {
        method: "POST",
        body: fd,
      });
      assert.equal(failedBatch.status, 500);
      assert.equal(store.listUploadsForRequest(createdJson.id).length, 0);
      assert.equal(store.getRequestItem(createdJson.id, fileItemId)!.status, "pending");
      const blobRoot = path.join(tmpDir, "blobs", wsId, createdJson.id, fileItemId);
      const remainingFiles = fs.existsSync(blobRoot) ? fs.readdirSync(blobRoot) : [];
      assert.equal(remainingFiles.length, 0, "First blob must be cleaned up when second file put fails");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
