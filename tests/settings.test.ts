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

async function bootApp(options?: { multiTenant?: boolean; fetchImpl?: typeof fetch }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-settings-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    BASE_URL: "http://localhost:3080",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
    MULTI_TENANT: options?.multiTenant ? "true" : "false",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const email = new MemoryEmailAdapter();
  const { app, store } = createApp({
    config,
    db,
    storage: createStorageAdapter(config),
    email,
    fetchImpl: options?.fetchImpl,
  });

  const setup = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceName: "Harbour Advisory",
      email: "ops@harbour.test",
      password: "correct-horse-battery",
      loadDemo: false,
    }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];

  const json = (method: string, url: string, body?: unknown, extraCookie = cookie) =>
    app.request(url, {
      method,
      headers: {
        cookie: extraCookie,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  return {
    app,
    db,
    store,
    cookie,
    json,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Workspace email config: encrypts secrets, hides them on GET, preserves omitted passwords, validates headers/ports", async () => {
  const ctx = await bootApp();
  try {
    // 1. Save SMTP settings
    const smtpSave = await ctx.json("PUT", "/api/settings/email", {
      backend: "smtp",
      from: "Harbour Advisory <portal@harbour.test>",
      replyTo: "support@harbour.test",
      smtp: {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        user: "portal@harbour.test",
        pass: "super-secret-app-password",
      },
    });
    assert.equal(smtpSave.status, 200);
    const savedBody = (await smtpSave.json()) as {
      email: {
        source: string;
        backend: string;
        from: string;
        replyTo: string;
        smtp: { host: string; port: number; secure: boolean; user: string; hasPass: boolean };
      };
    };
    assert.equal(savedBody.email.source, "workspace");
    assert.equal(savedBody.email.backend, "smtp");
    assert.equal(savedBody.email.smtp.hasPass, true);
    assert.equal(JSON.stringify(savedBody).includes("super-secret-app-password"), false);

    // 2. Verify SQLite stores encrypted blob and never plaintext secret
    const row = ctx.db.prepare("SELECT email_config_encrypted FROM workspaces LIMIT 1").get() as {
      email_config_encrypted: string;
    };
    assert.ok(row.email_config_encrypted.startsWith("v1:"));
    assert.equal(row.email_config_encrypted.includes("super-secret-app-password"), false);

    // 3. GET /api/settings exposes account + sanitized email, never plaintext password
    const settingsRes = await ctx.json("GET", "/api/settings");
    assert.equal(settingsRes.status, 200);
    const settingsText = await settingsRes.text();
    assert.equal(settingsText.includes("super-secret-app-password"), false);
    const settingsJson = JSON.parse(settingsText) as {
      account: { email: string; workspaceName: string; displayName: string };
      email: { smtp: { hasPass: boolean } };
      readiness: { emailBackend: string; emailFrom: string };
    };
    assert.equal(settingsJson.account.email, "ops@harbour.test");
    assert.equal(settingsJson.account.workspaceName, "Harbour Advisory");
    assert.equal(settingsJson.email.smtp.hasPass, true);
    assert.equal(settingsJson.readiness.emailBackend, "smtp");
    assert.equal(settingsJson.readiness.emailFrom, "Harbour Advisory <portal@harbour.test>");

    // 4. Updating SMTP host without re-sending password preserves existing password
    const updateHost = await ctx.json("PUT", "/api/settings/email", {
      backend: "smtp",
      from: "Harbour Advisory <portal@harbour.test>",
      smtp: {
        host: "smtp.fastmail.com",
        port: 465,
        secure: true,
        user: "portal@harbour.test",
      },
    });
    assert.equal(updateHost.status, 200);
    const afterUpdate = (await updateHost.json()) as { email: { smtp: { host: string; hasPass: boolean } } };
    assert.equal(afterUpdate.email.smtp.host, "smtp.fastmail.com");
    assert.equal(afterUpdate.email.smtp.hasPass, true);

    // 5. Rejects CRLF header injection and invalid ports
    const crlf = await ctx.json("PUT", "/api/settings/email", {
      backend: "smtp",
      from: "Harbour <a@b.com>\r\nBcc: evil@attacker.test",
      smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    });
    assert.equal(crlf.status, 400);

    const badPort = await ctx.json("PUT", "/api/settings/email", {
      backend: "smtp",
      from: "a@b.com",
      smtp: { host: "smtp.gmail.com", port: 70000, secure: false },
    });
    assert.equal(badPort.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test("Email delivery test endpoint: supports Resend mocked success/failure and console outbox capture", async () => {
  const resendCalls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  let failNext = false;
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    const headers = (init?.headers || {}) as Record<string, string>;
    resendCalls.push({ url: String(input), auth: headers.authorization || "", body });
    if (failNext) {
      return new Response(JSON.stringify({ message: "Domain not verified" }), { status: 422 });
    }
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  }) as typeof fetch;

  const ctx = await bootApp({ fetchImpl: mockFetch });
  try {
    const saveResend = await ctx.json("PUT", "/api/settings/email", {
      backend: "resend",
      from: "Harbour <hello@harbour.test>",
      replyTo: "reply@harbour.test",
      resend: { apiKey: "re_test_123456" },
    });
    assert.equal(saveResend.status, 200);

    const testOk = await ctx.json("POST", "/api/settings/email/test", { to: "verify@harbour.test" });
    assert.equal(testOk.status, 200);
    assert.equal(resendCalls.length, 1);
    assert.equal(resendCalls[0].url, "https://api.resend.com/emails");
    assert.equal(resendCalls[0].auth, "Bearer re_test_123456");
    assert.equal(resendCalls[0].body.reply_to, "reply@harbour.test");

    failNext = true;
    const testErr = await ctx.json("POST", "/api/settings/email/test", { to: "verify@harbour.test" });
    assert.equal(testErr.status, 400);
    const errBody = (await testErr.json()) as { ok: boolean; error: string };
    assert.equal(errBody.ok, false);
    assert.match(errBody.error, /422/);

    // Switch back to console outbox and verify test email writes to outbox_emails
    const toConsole = await ctx.json("PUT", "/api/settings/email", { backend: "console" });
    assert.equal(toConsole.status, 200);
    const consoleTest = await ctx.json("POST", "/api/settings/email/test", {});
    assert.equal(consoleTest.status, 200);

    const outbox = await ctx.json("GET", "/api/outbox");
    const outboxJson = (await outbox.json()) as {
      emailBackend: string;
      emails: Array<{ kind: string; recipient: string }>;
    };
    assert.equal(outboxJson.emailBackend, "console");
    assert.equal(outboxJson.emails[0].kind, "test");
    assert.equal(outboxJson.emails[0].recipient, "ops@harbour.test");
  } finally {
    ctx.cleanup();
  }
});

test("Account profile and password change: validates input, updates profile, revokes other sessions", async () => {
  const ctx = await bootApp({ multiTenant: true });
  try {
    // Second workspace to test email conflict check
    const signup2 = await ctx.app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Other Firm",
        email: "other@firm.test",
        password: "other-firm-password",
      }),
    });
    assert.equal(signup2.status, 200);

    // Duplicate email rejected
    const dup = await ctx.json("PUT", "/api/account", { email: "other@firm.test" });
    assert.equal(dup.status, 409);

    // Valid profile update
    const prof = await ctx.json("PUT", "/api/account", {
      workspaceName: "Harbour Tax & Advisory",
      displayName: "Sarah Mitchell",
      email: "sarah@harbour.test",
    });
    assert.equal(prof.status, 200);
    const profJson = (await prof.json()) as {
      user: { email: string; displayName: string };
      workspace: { name: string };
    };
    assert.equal(profJson.user.displayName, "Sarah Mitchell");
    assert.equal(profJson.user.email, "sarah@harbour.test");
    assert.equal(profJson.workspace.name, "Harbour Tax & Advisory");

    // Second session on same user should be invalidated after password change
    const secondLogin = await ctx.app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "sarah@harbour.test", password: "correct-horse-battery" }),
    });
    assert.equal(secondLogin.status, 200);
    const secondCookie = secondLogin.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];

    const wrongCur = await ctx.json("PUT", "/api/account/password", {
      currentPassword: "wrong-password",
      newPassword: "brand-new-secure-password",
    });
    assert.equal(wrongCur.status, 400);

    const tooShort = await ctx.json("PUT", "/api/account/password", {
      currentPassword: "correct-horse-battery",
      newPassword: "short",
    });
    assert.equal(tooShort.status, 400);

    const changed = await ctx.json("PUT", "/api/account/password", {
      currentPassword: "correct-horse-battery",
      newPassword: "brand-new-secure-password",
    });
    assert.equal(changed.status, 200);

    // Current session still works; second session was revoked
    assert.equal((await ctx.json("GET", "/api/settings")).status, 200);
    assert.equal((await ctx.json("GET", "/api/settings", undefined, secondCookie)).status, 401);

    // New password logs in cleanly
    const relogin = await ctx.app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "sarah@harbour.test", password: "brand-new-secure-password" }),
    });
    assert.equal(relogin.status, 200);
  } finally {
    ctx.cleanup();
  }
});
