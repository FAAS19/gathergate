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
import { runReminderSweep } from "../src/jobs/chaser.js";
import { resolveWebhookSecret } from "../src/jobs/webhook.js";
import {
  MCP_HEADERLESS_FALLBACK_VERSION,
  MCP_LEGACY_DEFAULT_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
} from "../src/mcp/server.js";

function modernHeaders(
  base: Record<string, string>,
  method: string,
  name?: string
): Record<string, string> {
  return {
    ...base,
    "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name !== undefined ? { "mcp-name": name } : {}),
  };
}

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

    // 5. Key with mcp:read succeeds on server/discover, initialize, notifications/initialized, skills, resources, read tools
    const readKey = await ctx.mintKey("Agent Reader", ["mcp:read"]);
    const authHeader = { authorization: `Bearer ${readKey.secret}` };

    // Origin validation (CWE-346): foreign Origin rejected with 403, matching Origin accepted
    const badOrigin = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 0, method: "ping" },
      { ...authHeader, origin: "https://evil.example" }
    );
    assert.equal(badOrigin.status, 403);

    // Headerless request assumes 2025-03-26 (no resultType / ttlMs)
    const okOrigin = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 0, method: "ping" },
      { ...authHeader, origin: "https://intake.harbour.test" }
    );
    assert.equal(okOrigin.status, 200);
    assert.equal(okOrigin.headers.get("mcp-protocol-version"), MCP_HEADERLESS_FALLBACK_VERSION);
    const okOriginJson = (await okOrigin.json()) as { result: Record<string, unknown> };
    assert.equal("resultType" in okOriginJson.result, false);

    // Unsupported MCP-Protocol-Version header & _meta rejected with HTTP 400 + JSON-RPC -32022
    const badHeaderVer = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 90, method: "ping" },
      { ...authHeader, "mcp-protocol-version": "1900-01-01" }
    );
    assert.equal(badHeaderVer.status, 400);
    const badHeaderVerJson = (await badHeaderVer.json()) as {
      error: { code: number; data: { supported: string[]; requested: string } };
    };
    assert.equal(badHeaderVerJson.error.code, -32022);
    assert.ok(badHeaderVerJson.error.data.supported.includes(MCP_MODERN_PROTOCOL_VERSION));
    assert.equal(badHeaderVerJson.error.data.requested, "1900-01-01");

    const badMetaVer = await ctx.mcpCall(
      {
        jsonrpc: "2.0",
        id: 91,
        method: "ping",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
      },
      authHeader
    );
    assert.equal(badMetaVer.status, 400);
    const badMetaVerJson = (await badMetaVer.json()) as { error: { code: number } };
    assert.equal(badMetaVerJson.error.code, -32022);

    // _meta declaring supported version without MCP-Protocol-Version header returns 400 + -32020
    const missingHeaderForMeta = await ctx.mcpCall(
      {
        jsonrpc: "2.0",
        id: 911,
        method: "ping",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION } },
      },
      authHeader
    );
    assert.equal(missingHeaderForMeta.status, 400);
    assert.equal(((await missingHeaderForMeta.json()) as { error: { code: number } }).error.code, -32020);

    // Modern 2026-07-28 requests validate Mcp-Method and Mcp-Name before dispatch (-32020 HTTP 400)
    const badMethodHeader = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 912, method: "tools/list" },
      { ...authHeader, "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION, "mcp-method": "tools/call" }
    );
    assert.equal(badMethodHeader.status, 400);
    assert.equal(((await badMethodHeader.json()) as { error: { code: number } }).error.code, -32020);

    const missingNameHeader = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 913, method: "tools/call", params: { name: "list_templates", arguments: {} } },
      modernHeaders(authHeader, "tools/call")
    );
    assert.equal(missingNameHeader.status, 400);
    assert.equal(((await missingNameHeader.json()) as { error: { code: number } }).error.code, -32020);

    const mismatchedResName = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 914, method: "resources/read", params: { uri: "skill://gathergate/SKILL.md" } },
      modernHeaders(authHeader, "resources/read", "skill://other/SKILL.md")
    );
    assert.equal(mismatchedResName.status, 400);
    assert.equal(((await mismatchedResName.json()) as { error: { code: number } }).error.code, -32020);

    // Unknown method returns HTTP 404 under 2026-07-28 and HTTP 200 under legacy 2025-11-25
    const modernUnknown = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 915, method: "custom/unknown" },
      modernHeaders(authHeader, "custom/unknown")
    );
    assert.equal(modernUnknown.status, 404);
    assert.equal(((await modernUnknown.json()) as { error: { code: number } }).error.code, -32601);

    const legacyUnknown = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 916, method: "custom/unknown" },
      { ...authHeader, "mcp-protocol-version": "2025-11-25" }
    );
    assert.equal(legacyUnknown.status, 200);
    assert.equal(((await legacyUnknown.json()) as { error: { code: number } }).error.code, -32601);

    // Earlier protocol version omits resultType and cache fields
    const legacyTools = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 92, method: "tools/list" },
      { ...authHeader, "mcp-protocol-version": "2025-11-25" }
    );
    assert.equal(legacyTools.status, 200);
    assert.equal(legacyTools.headers.get("mcp-protocol-version"), "2025-11-25");
    const legacyToolsJson = (await legacyTools.json()) as { result: Record<string, unknown> };
    assert.equal("resultType" in legacyToolsJson.result, false);
    assert.equal("ttlMs" in legacyToolsJson.result, false);
    assert.equal("cacheScope" in legacyToolsJson.result, false);

    // MCP 2026-07-28 server/discover, tools/list, resources/list include resultType, ttlMs, cacheScope
    const discoverRes = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 93, method: "server/discover" },
      modernHeaders(authHeader, "server/discover")
    );
    assert.equal(discoverRes.status, 200);
    const discoverJson = (await discoverRes.json()) as {
      result: {
        resultType: string;
        supportedVersions: string[];
        ttlMs: number;
        cacheScope: string;
        capabilities: { extensions: Record<string, unknown> };
        _meta: { "io.modelcontextprotocol/serverInfo": { name: string; version: string } };
      };
    };
    assert.equal(discoverJson.result.resultType, "complete");
    assert.ok(discoverJson.result.supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION));
    assert.equal(discoverJson.result.cacheScope, "public");
    assert.ok(discoverJson.result.ttlMs > 0);
    assert.equal(discoverJson.result._meta["io.modelcontextprotocol/serverInfo"].name, "gathergate");
    assert.ok("io.modelcontextprotocol/skills" in discoverJson.result.capabilities.extensions);

    const modernToolsRes = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 931, method: "tools/list" },
      modernHeaders(authHeader, "tools/list")
    );
    assert.equal(modernToolsRes.status, 200);
    const modernToolsJson = (await modernToolsRes.json()) as {
      result: { resultType: string; ttlMs: number; cacheScope: string; tools: unknown[] };
    };
    assert.equal(modernToolsJson.result.resultType, "complete");
    assert.equal(modernToolsJson.result.cacheScope, "public");
    assert.ok(modernToolsJson.result.ttlMs > 0);

    const modernResourcesRes = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 932, method: "resources/list" },
      modernHeaders(authHeader, "resources/list")
    );
    assert.equal(modernResourcesRes.status, 200);
    const modernResourcesJson = (await modernResourcesRes.json()) as {
      result: { resultType: string; ttlMs: number; cacheScope: string; resources: unknown[] };
    };
    assert.equal(modernResourcesJson.result.resultType, "complete");
    assert.equal(modernResourcesJson.result.cacheScope, "public");
    assert.ok(modernResourcesJson.result.ttlMs > 0);

    // Legacy initialize negotiates only legacy revisions (never 2026-07-28)
    const initUnsupportedOffer = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } },
      authHeader
    );
    assert.equal(initUnsupportedOffer.status, 200);
    assert.equal(initUnsupportedOffer.headers.get("mcp-protocol-version"), MCP_LEGACY_DEFAULT_VERSION);
    const initJson = (await initUnsupportedOffer.json()) as {
      result: {
        protocolVersion: string;
        capabilities: { extensions: Record<string, unknown> };
        serverInfo: { name: string };
      };
    };
    assert.equal(initJson.result.protocolVersion, MCP_LEGACY_DEFAULT_VERSION);
    assert.equal("resultType" in initJson.result, false);
    assert.equal(initJson.result.serverInfo.name, "gathergate");
    assert.ok("io.modelcontextprotocol/skills" in initJson.result.capabilities.extensions);

    const legacyInit = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 94, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      authHeader
    );
    assert.equal(legacyInit.status, 200);
    assert.equal(legacyInit.headers.get("mcp-protocol-version"), "2025-03-26");
    const legacyInitJson = (await legacyInit.json()) as {
      result: { protocolVersion: string };
    };
    assert.equal(legacyInitJson.result.protocolVersion, "2025-03-26");
    assert.equal("resultType" in legacyInitJson.result, false);

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
    const webhookCfg = await ctx.app.request("/api/settings/webhook", {
      method: "PUT",
      headers: { cookie: ctx.cookieA, "content-type": "application/json" },
      body: JSON.stringify({
        webhookUrl: "https://hooks.harbour.test/in",
        webhookSecret: "whsec_super_secret_harbour_999",
      }),
    });
    assert.equal(webhookCfg.status, 200);
    const workspaces = ctx.db
      .prepare("SELECT id, webhook_secret FROM workspaces")
      .all() as Array<{ id: string; webhook_secret: string | null }>;
    assert.ok(
      workspaces.some(
        (w) => resolveWebhookSecret(w, ctx.config.masterKey) === "whsec_super_secret_harbour_999"
      )
    );

    const rwKey = await ctx.mintKey("Agent Operator", ["mcp:read", "requests:write"]);
    const authA = { authorization: `Bearer ${rwKey.secret}` };

    // 1. SEP-2640 skills/list, skills/get, resources/list, resources/read
    const skillsList = (await (
      await ctx.mcpCall(
        { jsonrpc: "2.0", id: 10, method: "skills/list" },
        modernHeaders(authA, "skills/list")
      )
    ).json()) as {
      result: {
        resultType: string;
        skills: Array<{
          uri: string;
          frontmatter: { name: string; description: string };
          resources: Array<{ uri: string; digest: string; size: number }>;
        }>;
      };
    };
    assert.equal(skillsList.result.resultType, "complete");
    assert.equal(skillsList.result.skills.length, 1);
    const listedSkill = skillsList.result.skills[0];
    assert.equal(listedSkill.uri, "skill://gathergate/SKILL.md");
    assert.equal(listedSkill.frontmatter.name, "gathergate");
    assert.ok(listedSkill.frontmatter.description.length > 20);
    assert.equal(listedSkill.resources.length, 3);
    for (const resEntry of listedSkill.resources) {
      assert.match(resEntry.digest, /^sha256:[0-9a-f]{64}$/);
      assert.ok(resEntry.size > 0);
    }

    const skillGet = (await (
      await ctx.mcpCall(
        { jsonrpc: "2.0", id: 11, method: "skills/get", params: { uri: "skill://gathergate/SKILL.md" } },
        modernHeaders(authA, "skills/get")
      )
    ).json()) as {
      result: {
        resultType: string;
        skill: {
          uri: string;
          frontmatter: { name: string; description: string };
          resources: Array<{ uri: string; digest: string; size: number }>;
        };
      };
    };
    assert.equal(skillGet.result.resultType, "complete");
    assert.equal(skillGet.result.skill.uri, listedSkill.uri);
    assert.deepEqual(skillGet.result.skill.frontmatter, listedSkill.frontmatter);
    assert.deepEqual(skillGet.result.skill.resources, listedSkill.resources);

    const skillRead = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "resources/read",
          params: { uri: "skill://gathergate/SKILL.md" },
        },
        modernHeaders(authA, "resources/read", "skill://gathergate/SKILL.md")
      )
    ).json()) as {
      result: {
        resultType: string;
        ttlMs: number;
        cacheScope: string;
        contents: Array<{ uri: string; text: string }>;
      };
    };
    assert.equal(skillRead.result.resultType, "complete");
    assert.equal(skillRead.result.cacheScope, "public");
    assert.ok(skillRead.result.ttlMs > 0);
    assert.match(skillRead.result.contents[0].text, /Hard Security Boundary/);
    const rootResEntry = skillGet.result.skill.resources.find((r) => r.uri === "skill://gathergate/SKILL.md")!;
    assert.equal(rootResEntry.size, Buffer.byteLength(skillRead.result.contents[0].text, "utf8"));
    assert.equal(
      rootResEntry.digest,
      `sha256:${crypto.createHash("sha256").update(skillRead.result.contents[0].text, "utf8").digest("hex")}`
    );

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

    // Retrying update_due_date with unchanged due_at must preserve overdue_notified_at
    ctx.db
      .prepare("UPDATE requests SET overdue_notified_at = ? WHERE id = ?")
      .run("2026-11-26T00:00:00.000Z", reqId);
    const sameDueRes = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 25,
          method: "tools/call",
          params: { name: "update_due_date", arguments: { request_id: reqId, due_at: newDue } },
        },
        authA
      )
    ).json()) as { result: { isError: boolean } };
    assert.equal(sameDueRes.result.isError, false);
    const afterSameDue = ctx.db
      .prepare("SELECT due_at, overdue_notified_at FROM requests WHERE id = ?")
      .get(reqId) as { due_at: string | null; overdue_notified_at: string | null };
    assert.equal(afterSameDue.due_at, newDue);
    assert.equal(afterSameDue.overdue_notified_at, "2026-11-26T00:00:00.000Z");

    // Changing due_at persists the new deadline and clears overdue_notified_at
    const nextDue = "2026-12-21T00:00:00.000Z";
    const changedDueRes = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 26,
          method: "tools/call",
          params: { name: "update_due_date", arguments: { request_id: reqId, due_at: nextDue } },
        },
        authA
      )
    ).json()) as { result: { isError: boolean; structuredContent: { due_at: string } } };
    assert.equal(changedDueRes.result.isError, false);
    assert.equal(changedDueRes.result.structuredContent.due_at, nextDue);
    const afterChangedDue = ctx.db
      .prepare("SELECT due_at, overdue_notified_at FROM requests WHERE id = ?")
      .get(reqId) as { due_at: string | null; overdue_notified_at: string | null };
    assert.equal(afterChangedDue.due_at, nextDue);
    assert.equal(afterChangedDue.overdue_notified_at, null);

    // Short email local parts withhold characters (CWE-200)
    const shortCreate = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 27,
          method: "tools/call",
          params: {
            name: "create_request",
            arguments: {
              template_id: taxTpl.template_id,
              title: "Short Email Pack",
              client_name: "Al",
              client_email: "ab@example.com",
              send_invite: false,
            },
          },
        },
        authA
      )
    ).json()) as { result: { structuredContent: { request_id: string } } };
    const shortStatus = (await (
      await ctx.mcpCall(
        {
          jsonrpc: "2.0",
          id: 28,
          method: "tools/call",
          params: {
            name: "get_request_status",
            arguments: { request_id: shortCreate.result.structuredContent.request_id },
          },
        },
        authA
      )
    ).json()) as { result: { structuredContent: { client_email_masked: string } } };
    assert.equal(shortStatus.result.structuredContent.client_email_masked, "***@example.com");

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

    const mailCountBeforeCrossTenant = ctx.email.sent.length;
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
      ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
      assert.equal(r.result.isError, true, `Expected cross-tenant denial on ${badCall.name}`);
      if (badCall.name === "send_reminder") {
        assert.equal(r.result.content[0].text, "Request not found.");
      }
    }
    assert.equal(ctx.email.sent.length, mailCountBeforeCrossTenant);

    // 6. Validate server.json manifest schema & fields (description <= 100 chars per schema)
    const serverJson = JSON.parse(
      fs.readFileSync(path.resolve("server.json"), "utf8")
    ) as {
      name: string;
      version: string;
      websiteUrl?: string;
      description: string;
      packages: Array<{ version: string }>;
      remotes: Array<{ type: string; url: string }>;
    };
    const rootPkg = JSON.parse(
      fs.readFileSync(path.resolve("package.json"), "utf8")
    ) as { mcpName?: string; homepage?: string; version: string };
    assert.equal(serverJson.name, "app.gathergate/gathergate");
    assert.equal(rootPkg.mcpName, serverJson.name);
    assert.equal(serverJson.websiteUrl, "https://gathergate.app");
    assert.equal(rootPkg.homepage, serverJson.websiteUrl);
    assert.equal(serverJson.version, rootPkg.version);
    assert.equal(serverJson.packages[0].version, rootPkg.version);
    assert.ok(serverJson.description.length > 0 && serverJson.description.length <= 100);
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

    // Live server/discover (2026-07-28) + legacy initialize -> tools/list -> list_templates
    const discover = await fetch(endpoint, {
      method: "POST",
      headers: modernHeaders(headers, "server/discover"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    });
    assert.equal(discover.status, 200);
    assert.equal(discover.headers.get("cache-control"), "no-store");
    assert.equal(discover.headers.get("mcp-protocol-version"), MCP_MODERN_PROTOCOL_VERSION);

    const init = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
    });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("mcp-protocol-version"), MCP_LEGACY_DEFAULT_VERSION);

    const notif = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notif.status, 202);

    const tools = (await (
      await fetch(endpoint, {
        method: "POST",
        headers: modernHeaders(headers, "tools/list"),
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      })
    ).json()) as { result: { resultType: string; ttlMs: number; tools: Array<{ name: string }> } };
    assert.equal(tools.result.resultType, "complete");
    assert.ok(tools.result.ttlMs > 0);
    assert.equal(tools.result.tools.length, 7);

    const tplRes = (await (
      await fetch(endpoint, {
        method: "POST",
        headers: modernHeaders(headers, "tools/call", "list_templates"),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_templates", arguments: {} },
        }),
      })
    ).json()) as { result: { resultType: string; isError: boolean; structuredContent: { templates: unknown[] } } };
    assert.equal(tplRes.result.resultType, "complete");
    assert.equal(tplRes.result.isError, false);
    assert.ok(tplRes.result.structuredContent.templates.length >= 4);
  } finally {
    server.close();
    ctx.cleanup();
  }
});

test("MCP 2.0: concurrent send_reminder and scheduled sweep share per-request reservation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-mcp-race-"));
  let releaseSend!: () => void;
  let markSendEntered!: () => void;
  let sendCount = 0;
  const gate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const sendEntered = new Promise<void>((resolve) => {
    markSendEntered = resolve;
  });

  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    BASE_URL: "https://intake.harbour.test",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
    MULTI_TENANT: "false",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const storage = createStorageAdapter(config);
  const delayedEmail = {
    async send() {
      sendCount += 1;
      markSendEntered();
      await gate;
    },
  };
  const { app, store, inFlightReminders } = createApp({
    config,
    db,
    storage,
    email: delayedEmail,
    now: () => Date.parse("2026-11-27T00:00:00.000Z"),
  });

  const startedCalls: Array<Promise<Response>> = [];
  try {
    const setup = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Harbour Race",
        email: "ops@harbour.test",
        password: "harbour-secure-password",
        loadDemo: false,
      }),
    });
    assert.equal(setup.status, 200);
    const cookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");

    const keyRes = await app.request("/api/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Race Agent", scopes: ["mcp:read", "requests:write"] }),
    });
    assert.equal(keyRes.status, 201);
    const { secret } = (await keyRes.json()) as { secret: string };
    const auth = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

    const tpls = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_templates", arguments: {} },
        }),
      })
    ).json()) as { result: { structuredContent: { templates: Array<{ template_id: string }> } } };

    const created = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_request",
            arguments: {
              template_id: tpls.result.structuredContent.templates[0].template_id,
              title: "Overlap Pack",
              client_name: "Sam",
              client_email: "sam@example.com",
              send_invite: false,
            },
          },
        }),
      })
    ).json()) as { result: { structuredContent: { request_id: string } } };
    const reqId = created.result.structuredContent.request_id;

    // Make the request also look due for the scheduled reminder sweep
    db.prepare("UPDATE requests SET next_reminder_at = ? WHERE id = ?").run(
      "2026-11-26T00:00:00.000Z",
      reqId
    );

    // Start call A and wait until it has entered the email adapter
    const callA = app.request("/mcp", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send_reminder", arguments: { request_id: reqId } },
      }),
    });
    startedCalls.push(callA);
    await sendEntered;

    // Fire competing call B with a bounded timeout so any reservation regression fails fast
    const callB = app.request("/mcp", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "send_reminder", arguments: { request_id: reqId } },
      }),
    });
    startedCalls.push(callB);

    const boundedB = await Promise.race([
      callB,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Competing send_reminder hung on email gate")), 2000);
        timer.unref();
      }),
    ]);
    const resB = (await boundedB.json()) as { result: { isError: boolean } };
    assert.equal(resB.result.isError, true);
    assert.equal(sendCount, 1);

    // Scheduled sweep must skip the reserved request too
    const sweepSent = await runReminderSweep({
      store,
      email: delayedEmail,
      baseUrl: config.baseUrl,
      masterKey: config.masterKey,
      config,
      nowIso: "2026-11-27T00:00:00.000Z",
      inFlightReminders,
    });
    assert.equal(sweepSent, 0);
    assert.equal(sendCount, 1);

    releaseSend();
    const resA = (await (await callA).json()) as {
      result: { isError: boolean; structuredContent?: { reminders_sent: number } };
    };
    assert.equal(resA.result.isError, false);
    assert.equal(resA.result.structuredContent?.reminders_sent, 1);
    assert.equal(sendCount, 1);
  } finally {
    releaseSend();
    await Promise.allSettled(startedCalls);
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MCP 2.0 hardening: /.well-known 404, CORS preflight, Accept 406, protocol negotiation, resources/templates/list & -32603 error handling", async () => {
  const ctx = await bootMcpApp();
  try {
    const readKey = await ctx.mintKey("Hardening Reader", ["mcp:read"]);
    const auth = { authorization: `Bearer ${readKey.secret}` };

    // 1. /.well-known/* returns 404 JSON (never 200 HTML SPA fallback)
    const wk = await ctx.app.request("/.well-known/oauth-protected-resource");
    assert.equal(wk.status, 404);
    assert.match(wk.headers.get("content-type") || "", /application\/json/);

    // 2. CORS preflight OPTIONS /mcp + POST /mcp CORS headers + Cache-Control: no-store
    const badPreflight = await ctx.app.request("/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(badPreflight.status, 403);
    assert.equal(badPreflight.headers.get("access-control-allow-origin"), null);

    const okPreflight = await ctx.app.request("/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://intake.harbour.test" },
    });
    assert.equal(okPreflight.status, 204);
    assert.equal(okPreflight.headers.get("access-control-allow-origin"), "https://intake.harbour.test");
    assert.match(okPreflight.headers.get("access-control-allow-methods") || "", /POST/);
    assert.match(okPreflight.headers.get("access-control-allow-headers") || "", /MCP-Protocol-Version/i);
    assert.equal(okPreflight.headers.get("vary"), "Origin");
    assert.equal(okPreflight.headers.get("cache-control"), "no-store");

    // 401 with allowed Origin still carries CORS + Cache-Control: no-store
    const unauthOrigin = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "https://intake.harbour.test" }
    );
    assert.equal(unauthOrigin.status, 401);
    assert.equal(unauthOrigin.headers.get("access-control-allow-origin"), "https://intake.harbour.test");
    assert.match(unauthOrigin.headers.get("access-control-expose-headers") || "", /WWW-Authenticate/i);
    assert.equal(unauthOrigin.headers.get("cache-control"), "no-store");

    // 3. Accept header: application/json + text/event-stream accepted; event-stream-only rejected with 406
    const okAccept = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { ...auth, accept: "application/json, text/event-stream" }
    );
    assert.equal(okAccept.status, 200);
    const badAccept = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { ...auth, accept: "text/event-stream" }
    );
    assert.equal(badAccept.status, 406);
    const rejectedSpecificJson = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 31, method: "ping" },
      { ...auth, accept: "application/json;q=0, application/*;q=1" }
    );
    assert.equal(rejectedSpecificJson.status, 406);

    // 4. Protocol negotiation: initialize validates explicit header; headerless server/discover uses 2026-07-28
    const badInitHeader = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { ...auth, "mcp-protocol-version": "1900-01-01" }
    );
    assert.equal(badInitHeader.status, 400);
    assert.equal(((await badInitHeader.json()) as { error: { code: number } }).error.code, -32022);

    const modernInitHeader = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { ...auth, "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION }
    );
    assert.equal(modernInitHeader.status, 404);
    assert.equal(((await modernInitHeader.json()) as { error: { code: number } }).error.code, -32601);

    const coldDiscover = await ctx.mcpCall({ jsonrpc: "2.0", id: 6, method: "server/discover" }, auth);
    assert.equal(coldDiscover.status, 200);
    assert.equal(coldDiscover.headers.get("mcp-protocol-version"), MCP_MODERN_PROTOCOL_VERSION);
    const coldDiscoverJson = (await coldDiscover.json()) as { result: { resultType: string } };
    assert.equal(coldDiscoverJson.result.resultType, "complete");

    // 5. resources/templates/list, skills cache fields, portable tool schemas, non-object arguments guard
    const resTemplates = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 7, method: "resources/templates/list" },
      modernHeaders(auth, "resources/templates/list")
    );
    assert.equal(resTemplates.status, 200);
    const resTemplatesJson = (await resTemplates.json()) as {
      result: { resultType: string; ttlMs: number; resourceTemplates: unknown[] };
    };
    assert.equal(resTemplatesJson.result.resultType, "complete");
    assert.ok(resTemplatesJson.result.ttlMs > 0);
    assert.deepEqual(resTemplatesJson.result.resourceTemplates, []);

    const skillsModern = (await (
      await ctx.mcpCall(
        { jsonrpc: "2.0", id: 8, method: "skills/list" },
        modernHeaders(auth, "skills/list")
      )
    ).json()) as { result: { ttlMs: number; cacheScope: string } };
    assert.ok(skillsModern.result.ttlMs > 0);
    assert.equal(skillsModern.result.cacheScope, "public");

    const toolsList = (await (
      await ctx.mcpCall({ jsonrpc: "2.0", id: 9, method: "tools/list" }, auth)
    ).json()) as { result: { tools: Array<{ inputSchema: { properties?: Record<string, { type?: unknown }> } }> } };
    for (const tool of toolsList.result.tools) {
      for (const prop of Object.values(tool.inputSchema.properties ?? {})) {
        assert.equal(Array.isArray(prop.type), false, "Tool schema property must not use array type");
      }
    }

    const badArgs = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_templates", arguments: [] } },
      auth
    );
    assert.equal(badArgs.status, 200);
    assert.equal(((await badArgs.json()) as { error: { code: number } }).error.code, -32602);

    // 6. Unhandled internal error inside MCP returns JSON-RPC -32603 (not plain-text 500)
    const wsId = (ctx.db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
    ctx.db
      .prepare("INSERT INTO templates (id, workspace_id, name, description, items_json, is_builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run("tpl_corrupt", wsId, "Corrupt", "", "{not-valid-json", new Date().toISOString());
    const errRes = await ctx.mcpCall(
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "list_templates", arguments: {} } },
      auth
    );
    assert.equal(errRes.status, 500);
    const errJson = (await errRes.json()) as { jsonrpc: string; id: number; error: { code: number } };
    assert.equal(errJson.jsonrpc, "2.0");
    assert.equal(errJson.id, 11);
    assert.equal(errJson.error.code, -32603);
  } finally {
    ctx.cleanup();
  }
});

test("MCP 2.0 hardening: strict args, strict ISO due_at, sanitised email errors, ASC overdue order & HTTP 415", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-mcp-hardening-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    BASE_URL: "http://127.0.0.1:3080",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
    MULTI_TENANT: "false",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const storage = createStorageAdapter(config);
  const throwingEmail = {
    async send() {
      throw new Error("550 5.1.1 <secret-client@example.com> user unknown on smtp.internal:587");
    },
  };
  const { app, store } = createApp({
    config,
    db,
    storage,
    email: throwingEmail,
    now: () => Date.parse("2026-11-28T00:00:00.000Z"),
  });

  try {
    const setupRes = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Single Tenant Firm",
        email: "ops@single.test",
        password: "single-secure-password",
        loadDemo: false,
      }),
    });
    assert.equal(setupRes.status, 200);
    const cookie = extractCookie(setupRes.headers.get("set-cookie"), "gg_session");
    const keyRes = await app.request("/api/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent", scopes: ["mcp:read", "requests:write"] }),
    });
    const { secret } = (await keyRes.json()) as { secret: string };
    const auth = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

    // 1. POST /mcp rejects non-JSON Content-Type with HTTP 415
    const badCt = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(badCt.status, 415);

    const tplsRes = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_templates", arguments: {} } }),
      })
    ).json()) as { result: { structuredContent: { templates: Array<{ template_id: string }> } } };
    const tplId = tplsRes.result.structuredContent.templates[0].template_id;

    // 2. Reject unknown args (e.g. send_email typo) & invalid rollover due_at
    const unknownArgRes = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "create_request",
            arguments: {
              template_id: tplId,
              title: "Typo Test",
              client_name: "Bob",
              client_email: "bob@example.com",
              send_email: false,
            },
          },
        }),
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(unknownArgRes.result.isError, true);
    assert.match(unknownArgRes.result.content[0].text, /Unknown argument/i);

    const rolloverDueRes = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "create_request",
            arguments: {
              template_id: tplId,
              title: "Rollover Date",
              client_name: "Bob",
              client_email: "bob@example.com",
              due_at: "2026-02-31",
            },
          },
        }),
      })
    ).json()) as { result: { isError: boolean } };
    assert.equal(rolloverDueRes.result.isError, true);

    // 3. Sanitised email errors in MULTI_TENANT=false (never leak raw email / SMTP host)
    const createFailMail = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "create_request",
            arguments: {
              template_id: tplId,
              title: "Fail Mail",
              client_name: "Secret Client",
              client_email: "secret-client@example.com",
              due_at: "2026-11-01",
            },
          },
        }),
      })
    ).json()) as { result: { isError: boolean; structuredContent: { request_id: string; invite_error: string } } };
    assert.equal(createFailMail.result.isError, false);
    assert.equal(
      createFailMail.result.structuredContent.invite_error,
      "Invite email failed to send. Check outbound email settings."
    );
    const req1Id = createFailMail.result.structuredContent.request_id;

    const remindFail = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "send_reminder", arguments: { request_id: req1Id } },
        }),
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(remindFail.result.isError, true);
    assert.equal(
      remindFail.result.content[0].text,
      "Reminder email failed to send. Check outbound email settings."
    );
    assert.equal(remindFail.result.content[0].text.includes("secret-client@example.com"), false);

    // 4. list_overdue_requests sorts oldest due_at ASC before slicing
    const createOlder = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "create_request",
            arguments: {
              template_id: tplId,
              title: "Oldest Overdue",
              client_name: "Old",
              client_email: "old@example.com",
              due_at: "2026-10-01",
              send_invite: false,
            },
          },
        }),
      })
    ).json()) as { result: { structuredContent: { request_id: string } } };

    const overdueRes = (await (
      await app.request("/mcp", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "list_overdue_requests", arguments: { limit: 1 } },
        }),
      })
    ).json()) as { result: { structuredContent: { requests: Array<{ request_id: string }> } } };
    assert.equal(overdueRes.result.structuredContent.requests[0].request_id, createOlder.result.structuredContent.request_id);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
