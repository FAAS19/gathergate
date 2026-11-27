import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryEmailAdapter } from "../src/adapters/email.js";
import { createStorageAdapter } from "../src/adapters/storage.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { runReminderSweep } from "../src/jobs/chaser.js";
import { runPurgeSweep } from "../src/jobs/purge.js";
import { generateOtpCode, hashPassword, verifyOtpCode, verifyPassword } from "../src/security/auth.js";
import { decryptBuffer, decryptField, encryptBuffer, encryptField, hmacSha256Hex } from "../src/security/crypto.js";
import { detectFileSignature } from "../src/security/magic-bytes.js";
import { maskSensitiveValue, validateTextValue } from "../src/validators/index.js";

function extractCookie(setCookieHeader: string | null, name: string): string {
  assert.ok(setCookieHeader, `Expected Set-Cookie header containing ${name}`);
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Cookie ${name} not found in ${setCookieHeader}`);
  return `${name}=${match[1]}`;
}

test("Deterministic AU & generic validators accept valid inputs and reject bad checksums", () => {
  assert.deepEqual(validateTextValue("au_abn_mod89", "51824753556"), {
    valid: true,
    normalised: "51 824 753 556",
  });
  assert.equal(validateTextValue("au_abn_mod89", "51824753557").valid, false);

  assert.deepEqual(validateTextValue("au_bsb", "062000"), {
    valid: true,
    normalised: "062-000",
  });
  assert.equal(validateTextValue("au_bsb", "06200").valid, false);

  assert.deepEqual(validateTextValue("au_tfn_mod11", "876 543 210"), {
    valid: true,
    normalised: "876 543 210",
  });
  assert.equal(validateTextValue("au_tfn_mod11", "876 543 211").valid, false);
  assert.equal(maskSensitiveValue("au_tfn_mod11", "876 543 210"), "****** 210");

  assert.deepEqual(validateTextValue("au_medicare_mod10", "21234567011"), {
    valid: true,
    normalised: "2123 45670 1 / 1",
  });
  assert.equal(validateTextValue("au_medicare_mod10", "21234567111").valid, false);
  assert.equal(validateTextValue("au_medicare_mod10", "21234567001").valid, false);
  assert.equal(validateTextValue("au_medicare_mod10", "21234567010").valid, false);

  assert.deepEqual(validateTextValue("au_phone_e164", "0412 345 678"), {
    valid: true,
    normalised: "+61412345678",
  });
  assert.equal(validateTextValue("au_phone_e164", "12345").valid, false);
});

test("AES-256-GCM encryption, tamper detection, Argon2id/scrypt passwords, and OTP checks", async () => {
  const masterKey = crypto.randomBytes(32);

  const encField = encryptField(masterKey, "876 543 210", "item_1");
  assert.equal(decryptField(masterKey, encField, "item_1"), "876 543 210");
  assert.throws(() => decryptField(masterKey, encField, "wrong_aad"));

  const payload = Buffer.from("%PDF-1.4 sample confidential payload");
  const { ciphertext, meta } = encryptBuffer(masterKey, payload, "blob/1.enc");
  assert.notEqual(ciphertext.toString("utf8"), payload.toString("utf8"));
  const plain = await decryptBuffer(masterKey, ciphertext, meta, "blob/1.enc");
  assert.deepEqual(plain, payload);

  ciphertext[0] ^= 0xff;
  await assert.rejects(() => decryptBuffer(masterKey, ciphertext, meta, "blob/1.enc"));

  const pwHash = hashPassword("correct-horse-battery");
  assert.equal(verifyPassword("correct-horse-battery", pwHash), true);
  assert.equal(verifyPassword("wrong-password", pwHash), false);

  const otp = generateOtpCode();
  assert.match(otp.code, /^\d{6}$/);
  assert.equal(verifyOtpCode(otp.code, otp.hash), true);
  assert.equal(verifyOtpCode("000000", otp.hash), otp.code === "000000");
});

test("Magic-byte sniffer allows real PDF/PNG/CSV and blocks spoofed executables or script CSVs", () => {
  assert.deepEqual(detectFileSignature(Buffer.from("%PDF-1.7\n..."), "statement.pdf"), {
    mime: "application/pdf",
    ext: "pdf",
  });
  assert.deepEqual(
    detectFileSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), "logo.png"),
    { mime: "image/png", ext: "png" }
  );
  assert.deepEqual(detectFileSignature(Buffer.from("date,amount\n2026-07-01,100.00\n"), "bank.csv"), {
    mime: "text/csv",
    ext: "csv",
  });
  assert.equal(detectFileSignature(Buffer.from("MZ\x90\x00\x03\x00fake.pdf"), "invoice.pdf"), null);
  assert.equal(detectFileSignature(Buffer.from("<script>alert(1)</script>"), "data.csv"), null);
});

test("End-to-end JSON API lifecycle: setup, demo seed/clear, outbox, OTP, preview, batch approve, webhook, ZIP, chaser & purge", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-test-"));
  const masterKeyHex = crypto.randomBytes(32).toString("hex");
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: masterKeyHex,
    BASE_URL: "http://localhost:3080",
    MULTI_TENANT: "true",
    FREE_MAX_ACTIVE_REQUESTS: "1",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const storage = createStorageAdapter(config);
  const email = new MemoryEmailAdapter();

  const webhookCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    webhookCalls.push({
      url: String(input),
      headers: (init?.headers as Record<string, string>) || {},
      body: String(init?.body || ""),
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const { app, store } = createApp({ config, db, storage, email, fetchImpl: mockFetch });

  try {
    // 0. Session check before setup
    const preSess = (await (await app.request("/api/session")).json()) as { needsSetup: boolean };
    assert.equal(preSess.needsSetup, true);

    // 1. First-boot setup with loadDemo = true
    const setupRes = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Melbourne Tax Advisory",
        email: "ops@taxfirm.com.au",
        password: "super-secure-password-123",
        loadDemo: true,
      }),
    });
    assert.equal(setupRes.status, 200);
    const opCookie = extractCookie(setupRes.headers.get("set-cookie"), "gg_session");

    // Demo requests & outbox emails exist + encrypted blobs created on disk
    const demoListRes = (await (
      await app.request("/api/requests", { headers: { cookie: opCookie } })
    ).json()) as {
      hasDemoData: boolean;
      requests: Array<{ id: string; is_demo: boolean }>;
    };
    assert.equal(demoListRes.hasDemoData, true);
    assert.equal(demoListRes.requests.length, 3);

    const outboxBeforeClear = (await (
      await app.request("/api/outbox", { headers: { cookie: opCookie } })
    ).json()) as { emails: Array<{ is_demo: number }> };
    assert.ok(outboxBeforeClear.emails.length >= 3);

    // Demo preview PDF works with inline headers and no X-Frame-Options: DENY
    const user = store.getUserByEmail("ops@taxfirm.com.au")!;
    const demoUploads = store.listUploadsForRequest(demoListRes.requests[0].id);
    assert.ok(demoUploads.length > 0);
    const demoPreviewRes = await app.request(`/api/uploads/${demoUploads[0].id}/preview`, {
      headers: { cookie: opCookie },
    });
    assert.equal(demoPreviewRes.status, 200);
    assert.match(demoPreviewRes.headers.get("content-disposition") || "", /^inline;/);
    assert.equal(demoPreviewRes.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(
      demoPreviewRes.headers.get("content-security-policy"),
      "default-src 'none'; sandbox; frame-ancestors 'self'"
    );
    const previewPdfBuf = Buffer.from(await demoPreviewRes.arrayBuffer());
    assert.equal(previewPdfBuf.subarray(0, 5).toString("ascii"), "%PDF-");

    // Clear demo data deletes DB rows and shreds demo encrypted blobs
    const firstDemoKey = demoUploads[0].storage_key;
    assert.equal(fs.existsSync(path.join(tmpDir, "blobs", firstDemoKey)), true);
    const clearRes = await app.request("/api/demo/clear", {
      method: "POST",
      headers: { cookie: opCookie },
    });
    assert.equal(clearRes.status, 200);
    assert.equal(fs.existsSync(path.join(tmpDir, "blobs", firstDemoKey)), false);

    // 2. Template CRUD
    const createTplRes = await app.request("/api/templates", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom Advisory Pack",
        description: "Test custom template",
        items: [{ section: "Entity", label: "Company ABN", kind: "text", required: true, validator: "au_abn_mod89" }],
      }),
    });
    assert.equal(createTplRes.status, 201);
    const createdTpl = ((await createTplRes.json()) as { template: { id: string } }).template;

    const updTplRes = await app.request(`/api/templates/${createdTpl.id}`, {
      method: "PUT",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom Advisory Pack v2",
        description: "Updated",
        items: [{ section: "Entity", label: "Company ABN", kind: "text", required: true, validator: "au_abn_mod89" }],
      }),
    });
    assert.equal(updTplRes.status, 200);

    const delTplRes = await app.request(`/api/templates/${createdTpl.id}`, {
      method: "DELETE",
      headers: { cookie: opCookie },
    });
    assert.equal(delTplRes.status, 200);

    // Built-in template cannot be deleted
    const templates = store.listTemplates(user.workspace_id);
    const eofyTpl = templates.find((t) => t.name.includes("AU Individual Tax Return"))!;
    assert.ok(eofyTpl);
    const delBuiltinRes = await app.request(`/api/templates/${eofyTpl.id}`, {
      method: "DELETE",
      headers: { cookie: opCookie },
    });
    assert.equal(delBuiltinRes.status, 400);

    // 3. Configure & test HMAC webhook
    const whSecret = "whsec_test_secret_123";
    const whRes = await app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        webhookUrl: "https://n8n.example.com/webhook/done",
        webhookSecret: whSecret,
      }),
    });
    assert.equal(whRes.status, 200);

    const whTestRes = await app.request("/api/settings/webhook/test", {
      method: "POST",
      headers: { cookie: opCookie },
    });
    assert.equal(whTestRes.status, 200);
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].headers["x-gathergate-event"], "webhook.test");

    // 4. Create AU EOFY Tax request with OTP gate
    const createRes = await app.request("/api/requests", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        templateId: eofyTpl.id,
        title: "FY26 Tax Pack",
        clientName: "Sam Citizen",
        clientEmail: "sam@example.com.au",
        requireOtp: true,
        sendInvite: true,
        reminderIntervalDays: 3,
        maxReminders: 3,
        purgeAfterDays: 30,
      }),
    });
    assert.equal(createRes.status, 201);
    const { id: requestId, portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const magicToken = portalUrl.split("/c/")[1];
    assert.equal(email.sent.length, 1);

    // Invite logged in local outbox
    const outboxAfterInvite = (await (
      await app.request("/api/outbox", { headers: { cookie: opCookie } })
    ).json()) as { emails: Array<{ kind: string; recipient: string }> };
    assert.equal(outboxAfterInvite.emails.length, 1);
    assert.equal(outboxAfterInvite.emails[0].kind, "invite");

    // 5. Client opens magic link API -> blocked by OTP gate
    const gateRes = await app.request(`/api/client/${magicToken}`);
    assert.equal(gateRes.status, 200);
    assert.equal(gateRes.headers.get("referrer-policy"), "no-referrer");
    const gateJson = (await gateRes.json()) as { requiresOtp: boolean };
    assert.equal(gateJson.requiresOtp, true);

    await app.request(`/api/client/${magicToken}/otp/send`, { method: "POST" });
    const otpMail = email.sent[email.sent.length - 1];
    const otpCode = otpMail.text.match(/\b(\d{6})\b/)![1];

    const badOtp = await app.request(`/api/client/${magicToken}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    assert.equal(badOtp.status, 400);

    const goodOtp = await app.request(`/api/client/${magicToken}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: otpCode }),
    });
    assert.equal(goodOtp.status, 200);
    const setCookieHeader = goodOtp.headers.get("set-cookie")!;
    assert.match(setCookieHeader, /Path=\/api\/client\//);
    const clientCookie = extractCookie(setCookieHeader, `gg_c_${requestId}`);

    // Unlocked client portal fetch
    const portalRes = await app.request(`/api/client/${magicToken}`, {
      headers: { cookie: clientCookie },
    });
    const portalJson = (await portalRes.json()) as { requiresOtp: boolean };
    assert.equal(portalJson.requiresOtp, false);

    // 6. Client submits required items
    const items = store.listRequestItems(requestId);
    const byValidator = (v: string) => items.find((i) => i.validator === v)!;
    const receiptsItem = items.find((i) => i.kind === "file" && i.required === 1)!;
    const declItem = items.find((i) => i.kind === "checkbox")!;

    const badTfnRes = await app.request(`/api/client/${magicToken}/items/${byValidator("au_tfn_mod11").id}`, {
      method: "POST",
      headers: { cookie: clientCookie, "content-type": "application/json" },
      body: JSON.stringify({ value: "876543211" }),
    });
    assert.equal(badTfnRes.status, 400);

    for (const [itemObj, payload] of [
      [byValidator("au_tfn_mod11"), { value: "876543210" }],
      [byValidator("au_bsb"), { value: "062000" }],
      [byValidator("au_phone_e164"), { value: "0412 345 678" }],
      [declItem, { checked: true }],
    ] as const) {
      const res = await app.request(`/api/client/${magicToken}/items/${itemObj.id}`, {
        method: "POST",
        headers: { cookie: clientCookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 200);
    }

    // Spoofed executable disguised as PDF rejected
    const badForm = new FormData();
    badForm.append("file", new File([Buffer.from("MZ\x90\x00evil")], "receipt.pdf", { type: "application/pdf" }));
    const spoofRes = await app.request(`/api/client/${magicToken}/items/${receiptsItem.id}`, {
      method: "POST",
      headers: { cookie: clientCookie },
      body: badForm,
    });
    assert.equal(spoofRes.status, 400);

    // Real PDF upload succeeds and is encrypted on disk
    const pdfPayload = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Title (Secret Tax Receipt) >>\nendobj\n%%EOF");
    const goodForm = new FormData();
    goodForm.append("file", new File([pdfPayload], "receipt-01.pdf", { type: "application/pdf" }));
    const okUploadRes = await app.request(`/api/client/${magicToken}/items/${receiptsItem.id}`, {
      method: "POST",
      headers: { cookie: clientCookie },
      body: goodForm,
    });
    assert.equal(okUploadRes.status, 200);

    const uploads = store.listUploadsForRequest(requestId);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].canonical_name, "sam-citizen_deduction-receipts_01.pdf");
    const onDisk = fs.readFileSync(path.join(tmpDir, "blobs", uploads[0].storage_key));
    assert.equal(onDisk.includes(Buffer.from("Secret Tax Receipt")), false);

    // 7. Operator detail masks TFN by default; reveal endpoint logs and returns plaintext
    const detailJson = (await (
      await app.request(`/api/requests/${requestId}`, { headers: { cookie: opCookie } })
    ).json()) as { items: Array<{ id: string; validator: string; displayValue: string; isSensitiveMasked: boolean }> };
    const tfnRow = detailJson.items.find((i) => i.validator === "au_tfn_mod11")!;
    assert.equal(tfnRow.displayValue, "****** 210");
    assert.equal(tfnRow.isSensitiveMasked, true);

    const revealRes = (await (
      await app.request(`/api/requests/${requestId}/items/${tfnRow.id}/reveal`, {
        method: "POST",
        headers: { cookie: opCookie },
      })
    ).json()) as { value: string };
    assert.equal(revealRes.value, "876 543 210");

    // 8. Operator rejects PDF -> email + outbox + chaser fires
    const emailsBeforeReject = email.sent.length;
    const rejRes = await app.request(`/api/requests/${requestId}/items/${receiptsItem.id}/review`, {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected", note: "Page 2 is blurry" }),
    });
    assert.equal(rejRes.status, 200);
    assert.equal(email.sent.length, emailsBeforeReject + 1);
    assert.match(email.sent[email.sent.length - 1].text, /Page 2 is blurry/);

    const futureIso = new Date(Date.now() + 4 * 86400_000).toISOString();
    const nudgesSent = await runReminderSweep({
      store,
      email,
      baseUrl: config.baseUrl,
      masterKey: config.masterKey,
      nowIso: futureIso,
      saveToOutbox: true,
    });
    assert.equal(nudgesSent, 1);
    assert.match(email.sent[email.sent.length - 1].subject, /^Reminder: \d+ items? left for /);

    // Re-upload receipts then use batch approve-all-submitted to complete request + trigger webhook
    const reupForm = new FormData();
    reupForm.append("file", new File([pdfPayload], "receipt-02.pdf", { type: "application/pdf" }));
    await app.request(`/api/client/${magicToken}/items/${receiptsItem.id}`, {
      method: "POST",
      headers: { cookie: clientCookie },
      body: reupForm,
    });

    const approveAllRes = await app.request(`/api/requests/${requestId}/approve-all-submitted`, {
      method: "POST",
      headers: { cookie: opCookie },
    });
    assert.equal(approveAllRes.status, 200);
    const approveAllJson = (await approveAllRes.json()) as {
      approvedCount: number;
      status: string;
      justCompleted: boolean;
    };
    assert.equal(approveAllJson.approvedCount, 5);
    assert.equal(approveAllJson.status, "completed");
    assert.equal(approveAllJson.justCompleted, true);

    const completedCalls = webhookCalls.filter(
      (call) => call.headers["x-gathergate-event"] === "request.completed"
    );
    assert.equal(completedCalls.length, 1);
    const wh = completedCalls[0];
    const ts = wh.headers["x-gathergate-timestamp"];
    const expectedSig = `t=${ts},v1=${hmacSha256Hex(whSecret, `${ts}.${wh.body}`)}`;
    assert.equal(wh.headers["x-gathergate-signature"], expectedSig);
    assert.ok(wh.headers["x-gathergate-delivery"]?.startsWith("whd_"));
    assert.doesNotMatch(wh.body, /876 543 210/);
    assert.match(wh.body, /\*\*\*\*\*\* 210/);
    assert.ok(webhookCalls.some((c) => c.headers["x-gathergate-event"] === "request.opened"));
    assert.ok(webhookCalls.some((c) => c.headers["x-gathergate-event"] === "item.submitted"));
    assert.ok(webhookCalls.some((c) => c.headers["x-gathergate-event"] === "request.in_review"));

    // 9. Streaming ZIP export returns PKZIP
    const zipRes = await app.request(`/api/requests/${requestId}/export.zip`, {
      headers: { cookie: opCookie },
    });
    assert.equal(zipRes.status, 200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(zipBuf.subarray(0, 2).toString("ascii"), "PK");

    // 10. Retention auto-purge shreds encrypted blobs
    const afterRetentionIso = new Date(Date.now() + 45 * 86400_000).toISOString();
    const purgeResult = await runPurgeSweep({ store, storage, nowIso: afterRetentionIso });
    assert.equal(purgeResult.requestsPurged, 1);
    assert.equal(purgeResult.filesDeleted, 2);
    assert.equal(fs.existsSync(path.join(tmpDir, "blobs", uploads[0].storage_key)), false);
    assert.equal(store.getRequestById(user.workspace_id, requestId)!.status, "purged");

    // 11. Multi-tenant isolation & free cap (FREE_MAX_ACTIVE_REQUESTS=1)
    const signupRes = await app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Free Solo Practice",
        email: "free@example.com",
        password: "another-secure-password",
      }),
    });
    assert.equal(signupRes.status, 200);
    const freeCookie = extractCookie(signupRes.headers.get("set-cookie"), "gg_session");
    const freeUser = store.getUserByEmail("free@example.com")!;
    const freeTpl = store.listTemplates(freeUser.workspace_id)[0];

    const idorRes = await app.request(`/api/requests/${requestId}`, { headers: { cookie: freeCookie } });
    assert.equal(idorRes.status, 404);

    const r1 = await app.request("/api/requests", {
      method: "POST",
      headers: { cookie: freeCookie, "content-type": "application/json" },
      body: JSON.stringify({
        templateId: freeTpl.id,
        title: "Req 1",
        clientName: "C1",
        clientEmail: "c1@example.com",
      }),
    });
    assert.equal(r1.status, 201);

    const r2 = await app.request("/api/requests", {
      method: "POST",
      headers: { cookie: freeCookie, "content-type": "application/json" },
      body: JSON.stringify({
        templateId: freeTpl.id,
        title: "Req 2",
        clientName: "C2",
        clientEmail: "c2@example.com",
      }),
    });
    assert.equal(r2.status, 403);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
