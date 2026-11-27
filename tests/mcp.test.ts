import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { MemoryEmailAdapter } from "../src/adapters/email.js";
import { createStorageAdapter } from "../src/adapters/storage.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { MCP_DEFAULT_PROTOCOL_VERSION } from "../src/mcp/server.js";

function extractCookie(setCookieHeader: string | null, name: string): string {
  assert.ok(setCookieHeader, `Expected Set-Cookie containing ${name}`);
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Cookie ${name} missing in ${setCookieHeader}`);
  return `${name}=${match[1]}`;
}

async function bootMcpApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-mcp-"));
  let currentNow = Date.parse("2026-11-27T00:00:00.000Z");
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    BASE_URL: "https://intake.harbour.test",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
    MULTI_TENANT: "true",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const storage = createStorageAdapter(config);
  const email = new MemoryEmailAdapter();
  const { app, store } = createApp({
    config,
    db,
    storage,
    email,
    now: () => currentNow,
  });

  const setup = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceName: "Harbour Advisory",
      email: "ops@harbour.test",
      password: "harbour-secure-password",
      loadDemo: false,
    }),
  });
  assert.equal(setup.status, 200);
  const cookieA = extractCookie(setup.headers.get("set-cookie"), "gg_session");

  const mintKey = async (name: string, scopes: string[], cookie = cookieA) => {
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name, scopes }),
    });
    assert.equal(res.status, 201);
    return (await res.json()) as { apiKey: { id: string }; secret: string };
  };

  const mcpCall = (
    body: unknown,
    headers: Record<string, string> = {}
  ) =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  return {
    app,
    db,
    store,
    email,
    config,
    cookieA,
    mintKey,
    mcpCall,
    nowMs: () => currentNow,
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("MCP 2.0: auth boundaries (Bearer-only, mcp:read gate, requests:write gate, 405 on GET, revocation)", async () => {
  const ctx = await bootMcpApp();
  try {
    // 1. Unauthenticated POST /mcp returns 401 with WWW-Authenticate
    const unauth = await ctx.mcpCall({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate") || "", /^Bearer\b/);

    // 2. Session cookies are NOT accepted on POST /mcp (Bearer API key only, eliminates CSRF)
    const cookieOnly = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { cookie: ctx.cookieA }
    );
    assert.equal(cookieOnly.status, 401);

    // 3. GET /mcp and DELETE /mcp return 405 Method Not Allowed (stateless transport)
    assert.equal((await ctx.app.request("/mcp", { method: "GET" })).status, 405);
    assert.equal((await ctx.app.request("/mcp", { method: "DELETE" })).status, 405);

    // 4. Key without mcp:read scope is rejected with 403
    const restOnlyKey = await ctx.mintKey("REST only", ["requests:read", "requests:write"]);
    const noMcpScope = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer ${restOnlyKey.secret}` }
    );
    assert.equal(noMcpScope.status, 403);

    // 5. Key with mcp:read succeeds on initialize, notifications/initialized, skills, resources, read tools
    const readKey = await ctx.mintKey("Agent Reader", ["mcp:read"]);
    const authHeader = { authorization: `Bearer ${readKey.secret}` };

    const initRes = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } },
      authHeader
    );
    assert.equal(initRes.status, 200);
    const initJson = (await initRes.json()) as {
      result: {
        protocolVersion: string;
        capabilities: { extensions: Record<string, unknown> };
        serverInfo: { name: string };
      };
    };
    assert.equal(initJson.result.protocolVersion, MCP_DEFAULT_PROTOCOL_VERSION);
    assert.equal(initJson.result.serverInfo.name, "gathergate");
    assert.ok("io.modelcontextprotocol/skills" in initJson.result.capabilities.extensions);

    // Notification returns 202 Accepted with no body
    const notifRes = await ctx.mcpCall(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      authHeader
    );
    assert.equal(notifRes.status, 202);

    // Read-only key cannot call write tools -> JSON-RPC -32003 with requiredScope
    const blockedWrite = await ctx.mcpCall(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_request",
          arguments: {
            template_id: "tpl_any",
            title: "Blocked",
            client_name: "Test",
            client_email: "test@example.com",
          },
        },
      },
      authHeader
    );
    assert.equal(blockedWrite.status, 200);
    const blockedJson = (await blockedWrite.json()) as {
      error: { code: number; data: { requiredScope: string } };
    };
    assert.equal(blockedJson.error.code, -32003);
    assert.equal(blockedJson.error.data.requiredScope, "requests:write");

    // Revoking key immediately blocks MCP with 401
    await ctx.app.request(`/api/api-keys/${readKey.apiKey.id}`, {
      method: "DELETE",
      headers: { cookie: ctx.cookieA },
    });
    const afterRevoke = await ctx.mcpCall({ jsonrpc: "2.0", id: 3, method: "ping" }, authHeader);
    assert.equal(afterRevoke.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test("MCP 2.0: strict zero-PII & zero-blob boundary, SEP-2640 SKILL.md resources, write tools & cross-tenant IDOR", async () => {
  const ctx = await bootMcpApp();
  try {
    // Configure workspace secrets that must NEVER leak through MCP
    await ctx.app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: ctx.cookieA, "content-type": "application/json" },
      body: JSON.stringify({
        webhookUrl: "https://hooks.harbour.test/in",
        webhookSecret: "whsec_super_secret_harbour_999",
      }),
    });

    const rwKey = await ctx.mintKey("Agent Operator", ["mcp:read", "requests:write"]);
    const authA = { authorization: `Bearer ${rwKey.secret}` };

    // 1. SEP-2640 skills/list, skills/get, resources/list, resources/read
    const skillsList = (await (
      await ctx.mcpCall({ jsonrpc: "2.0", id: 10, method: "skills/list" }, authA)
    ).json()) as { result: { skills: Array<{ uri: string; name: string; files: Array<{ uri: string }> }> } };
    assert.equal(skillsList.result.skills.length, 1);
    assert.equal(skillsList.result.skills[0].uri, "skill://gathergate/SKILL.md");
    assert.equal(skillsList.result.skills[0].files.length, 3);

    const skillGet = (await (
      await ctx.mcpCall(
        { jsonrpc: "2.0", id: 11, method: "skills/get", params: { uri: "skill://gathergate/SKILL.md" } },
        authA
      )
    ).json()) as { result: { skill: { name: string } } };
    assert.equal(skillGet.result.skill.name, "gathergate");

    const skillRead = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "resources/read",
          params: { uri: "skill://gathergate/SKILL.md" },
        },
        authA
      )
    ).json()) as { result: { contents: Array<{ uri: string; text: string }> } };
    assert.match(skillRead.result.contents[0].text, /Hard Security Boundary/);

    // Unknown resource fails closed with -32602
    const badRes = (await (
      await ctx.mcpCall(
        { jsonrpc: "2.0", id: 13, method: "resources/read", params: { uri: "file:///etc/passwd" } },
        authA
      )
    ).json()) as { error: { code: number } };
    assert.equal(badRes.error.code, -32602);

    // 2. list_templates + create_request from AU Individual Tax template (contains TFN + PDF upload)
    const tplList = (await (
      await ctx.mcpCall(
        { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "list_templates", arguments: {} } },
        authA
      )
    ).json()) as { result: { structuredContent: { templates: Array<{ template_id: string; name: string }> } } };
    const taxTpl = tplList.result.structuredContent.templates.find((t) => /Individual Tax/i.test(t.name))!;
    assert.ok(taxTpl);

    const pastDue = new Date(ctx.nowMs() - 2 * 86400_000).toISOString();
    const createRes = await ctx.mcpCall(
      {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: {
          name: "create_request",
          arguments: {
            template_id: taxTpl.template_id,
            title: "FY26 Tax Pack",
            client_name: "Claire Nguyen",
            client_email: "claire.secret@example.com.au",
            due_at: pastDue,
            require_otp: false,
            send_invite: true,
          },
        },
      },
      authA
    );
    const createText = await createRes.text();
    const createJson = JSON.parse(createText) as {
      result: {
        isError: boolean;
        structuredContent: { request_id: string; review_url: string; invite_sent: boolean };
      };
    };
    assert.equal(createJson.result.isError, false);
    assert.equal(createJson.result.structuredContent.invite_sent, true);
    const reqId = createJson.result.structuredContent.request_id;
    assert.equal(
      createJson.result.structuredContent.review_url,
      `https://intake.harbour.test/requests/${reqId}`
    );
    // Raw client magic-link token must NEVER appear in MCP response
    assert.equal(createText.includes("/c/"), false);

    // Extract magic token from sent invite email and have client submit TFN + secret note + PDF
    const inviteBody = ctx.email.sent[ctx.email.sent.length - 1].text;
    const magicToken = inviteBody.match(/\/c\/([A-Za-z0-9_-]+)/)![1];
    assert.equal(createText.includes(magicToken), false);

    const items = ctx.store.listRequestItems(reqId);
    const tfnItem = items.find((i) => i.validator === "au_tfn_mod11")!;
    const fileItem = items.find((i) => i.kind === "file")!;

    assert.equal(
      (
        await ctx.app.request(`/api/client/${magicToken}/items/${tfnItem.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "876543210" }),
        })
      ).status,
      200
    );
    assert.equal(
      (
        await ctx.app.request(`/api/client/${magicToken}/items/${tfnItem.id}/note`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "CONFIDENTIAL_CLIENT_NOTE_XYZ" }),
        })
      ).status,
      200
    );
    const pdfForm = new FormData();
    pdfForm.append(
      "file",
      new File(
        [Buffer.from("%PDF-1.4\n%SECRET_PDF_BYTES_999\n%%EOF\n")],
        "passport-scan-secret.pdf",
        { type: "application/pdf" }
      )
    );
    assert.equal(
      (
        await ctx.app.request(`/api/client/${magicToken}/items/${fileItem.id}`, {
          method: "POST",
          body: pdfForm,
        })
      ).status,
      200
    );

    // 3. Verify ZERO PII / ZERO file bytes / ZERO filenames / ZERO tokens across ALL read tools
    const readToolCalls = [
      { name: "list_requests", arguments: {} },
      { name: "get_request_status", arguments: { request_id: reqId } },
      { name: "list_overdue_requests", arguments: { within_days: 0 } },
    ];
    for (const tc of readToolCalls) {
      const res = await ctx.mcpCall(
        { jsonrpc: "2.0", id: 20, method: "tools/call", params: tc },
        authA
      );
      assert.equal(res.status, 200);
      const text = await res.text();
      for (const forbidden of [
        "876 543 210",
        "876543210",
        "****** 210",
        "CONFIDENTIAL_CLIENT_NOTE_XYZ",
        "passport-scan-secret.pdf",
        "SECRET_PDF_BYTES_999",
        "claire.secret@example.com.au",
        magicToken,
        "whsec_super_secret_harbour_999",
      ]) {
        assert.equal(
          text.includes(forbidden),
          false,
          `MCP tool ${tc.name} leaked forbidden value: ${forbidden}`
        );
      }
      assert.equal(text.includes("cl***@example.com.au"), true);
      assert.equal(text.includes(`https://intake.harbour.test/requests/${reqId}`), true);
    }

    const statusJson = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: { name: "get_request_status", arguments: { request_id: reqId } },
        },
        authA
      )
    ).json()) as {
      result: {
        structuredContent: {
          items: Array<{ item_id: string; has_value: boolean; has_client_note: boolean; upload_count: number }>;
        };
      };
    };
    const tfnMeta = statusJson.result.structuredContent.items.find((i) => i.item_id === tfnItem.id)!;
    assert.equal(tfnMeta.has_value, true);
    assert.equal(tfnMeta.has_client_note, true);
    const fileMeta = statusJson.result.structuredContent.items.find((i) => i.item_id === fileItem.id)!;
    assert.equal(fileMeta.upload_count, 1);

    // 4. Write tools: send_reminder (with cooldown) + update_due_date + audit attribution
    const rem1 = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: { name: "send_reminder", arguments: { request_id: reqId } },
        },
        authA
      )
    ).json()) as { result: { isError: boolean; structuredContent: { reminders_sent: number } } };
    assert.equal(rem1.result.isError, false);
    assert.equal(rem1.result.structuredContent.reminders_sent, 1);

    // Immediate second reminder hits 15m cooldown
    const rem2 = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 23,
          method: "tools/call",
          params: { name: "send_reminder", arguments: { request_id: reqId } },
        },
        authA
      )
    ).json()) as { result: { isError: boolean } };
    assert.equal(rem2.result.isError, true);

    const newDue = "2026-12-20T00:00:00.000Z";
    const dueRes = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 24,
          method: "tools/call",
          params: { name: "update_due_date", arguments: { request_id: reqId, due_at: newDue } },
        },
        authA
      )
    ).json()) as { result: { isError: boolean; structuredContent: { due_at: string } } };
    assert.equal(dueRes.result.isError, false);
    assert.equal(dueRes.result.structuredContent.due_at, newDue);

    const audit = ctx.store.listAuditEvents(reqId);
    assert.ok(audit.some((e) => e.actor === "api_key" && e.action === "request.created"));
    assert.ok(audit.some((e) => e.actor === "api_key" && e.action === "reminder.manual_sent"));
    assert.ok(audit.some((e) => e.actor === "api_key" && e.action === "request.due_date_updated"));

    // 5. Cross-tenant IDOR fails closed across all MCP tools
    const signupB = await ctx.app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Beta Tax",
        email: "ops@beta.test",
        password: "beta-secure-password",
      }),
    });
    const cookieB = extractCookie(signupB.headers.get("set-cookie"), "gg_session");
    const keyB = await ctx.mintKey("Beta Agent", ["mcp:read", "requests:write"], cookieB);
    const authB = { authorization: `Bearer ${keyB.secret}` };

    const listB = (await (
      await ctx.mcpCall(
        { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "list_requests", arguments: {} } },
        authB
      )
    ).json()) as { result: { structuredContent: { count: number } } };
    assert.equal(listB.result.structuredContent.count, 0);

    for (const badCall of [
      { name: "get_request_status", arguments: { request_id: reqId } },
      { name: "send_reminder", arguments: { request_id: reqId } },
      { name: "update_due_date", arguments: { request_id: reqId, due_at: null } },
      {
        name: "create_request",
        arguments: {
          template_id: taxTpl.template_id,
          title: "Cross-Tenant Template",
          client_name: "Evil",
          client_email: "evil@beta.test",
        },
      },
    ]) {
      const r = (await (
        await ctx.mcpCall(
          { jsonrpc: "2.0", id: 31, method: "tools/call", params: badCall },
          authB
        )
      ).json()) as { result: { isError: boolean } };
      assert.equal(r.result.isError, true, `Expected cross-tenant denial on ${badCall.name}`);
    }

    // 6. Validate server.json manifest schema & fields
    const serverJson = JSON.parse(
      fs.readFileSync(path.resolve("server.json"), "utf8")
    ) as { name: string; remotes: Array<{ type: string; url: string }> };
    assert.equal(serverJson.name, "dev.tensorforge/gathergate");
    assert.equal(serverJson.remotes[0].type, "streamable-http");
    assert.match(serverJson.remotes[0].url, /\/mcp$/);
  } finally {
    ctx.cleanup();
  }
});

test("MCP 2.0 live HTTP E2E: real TCP server initialize, tools/list, tools/call, skills/list, malformed JSON, and auth gates", async () => {
  const ctx = await bootMcpApp();
  const server = serve({ fetch: ctx.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  try {
    const key = await ctx.mintKey("Live HTTP Agent", ["mcp:read", "requests:write"]);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${key.secret}`,
    };

    // Unauthenticated live HTTP call rejected with 401
    const unauth = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate") || "", /^Bearer\b/);

    // Invalid JSON returns -32700 Parse error
    const badJson = await fetch(endpoint, {
      method: "POST",
      headers,
      body: "{not-json",
    });
    assert.equal(badJson.status, 400);
    const badJsonBody = (await badJson.json()) as { error: { code: number } };
    assert.equal(badJsonBody.error.code, -32700);

    // Live initialize -> notifications/initialized -> tools/list -> skills/list -> list_templates
    const init = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } }),
    });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("cache-control"), "no-store");
    assert.equal(init.headers.get("mcp-protocol-version"), MCP_DEFAULT_PROTOCOL_VERSION);

    const notif = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notif.status, 202);

    const tools = (await (
      await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    assert.equal(tools.result.tools.length, 7);

    const tplRes = (await (
      await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_templates", arguments: {} },
        }),
      })
    ).json()) as { result: { isError: boolean; structuredContent: { templates: unknown[] } } };
    assert.equal(tplRes.result.isError, false);
    assert.ok(tplRes.result.structuredContent.templates.length >= 4);
  } finally {
    server.close();
    ctx.cleanup();
  }
});
