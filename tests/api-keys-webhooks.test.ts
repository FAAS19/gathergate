import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryEmailAdapter } from "../src/adapters/email.js";
import { createStorageAdapter } from "../src/adapters/storage.js";
import { createApp, type RateLimitKey, type RateLimitRule } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { runPurgeSweep } from "../src/jobs/purge.js";
import {
  postPinnedHttps,
  runOverdueSweep,
  runWebhookRetrySweep,
  WEBHOOK_RETRY_DELAYS_MS,
} from "../src/jobs/webhook.js";
import { hmacSha256Hex, sha256Hex } from "../src/security/crypto.js";
import type { LookupAllFn } from "../src/security/ssrf.js";

function extractCookie(setCookieHeader: string | null, name: string): string {
  assert.ok(setCookieHeader, `Expected Set-Cookie containing ${name}`);
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Cookie ${name} missing in ${setCookieHeader}`);
  return `${name}=${match[1]}`;
}

async function bootApp(options?: {
  multiTenant?: boolean;
  trustProxy?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  rateLimits?: Partial<Record<RateLimitKey, RateLimitRule>>;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-apikeys-"));
  let currentNow = Date.parse("2026-11-27T00:00:00.000Z");
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
    lookupImpl: options?.lookupImpl,
    now: () => currentNow,
    rateLimits: options?.rateLimits,
  });

  const setup = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceName: "Alpha Advisory",
      email: "alpha@example.com",
      password: "alpha-secure-password",
      loadDemo: false,
    }),
  });
  assert.equal(setup.status, 200);
  const cookie = extractCookie(setup.headers.get("set-cookie"), "gg_session");

  return {
    config,
    db,
    storage,
    email,
    app,
    store,
    cookie,
    nowMs: () => currentNow,
    nowIso: () => new Date(currentNow).toISOString(),
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("API keys: hashed at rest, granular scope enforcement, session-only boundary, revocation, expiry & rate limits", async () => {
  const ctx = await bootApp({
    multiTenant: true,
    trustProxy: true,
    rateLimits: {
      apiKey: { limit: 4, windowMs: 60_000 },
      apiAuthIp: { limit: 3, windowMs: 60_000 },
    },
  });

  try {
    // 1. Rejects unknown scopes, empty scope lists, and non-numeric expiry types (fail closed)
    for (const badBody of [
      { name: "Empty", scopes: [] },
      { name: "Unknown", scopes: ["requests:read", "admin:all"] },
      { name: "Bad\r\nHeader", scopes: ["requests:read"] },
      { name: "BadExpiry", scopes: ["requests:read"], expiresInDays: 0 },
      { name: "ArrayExpiry", scopes: ["requests:read"], expiresInDays: [] },
      { name: "BoolExpiry", scopes: ["requests:read"], expiresInDays: true },
    ]) {
      const res = await ctx.app.request("/api/api-keys", {
        method: "POST",
        headers: { cookie: ctx.cookie, "content-type": "application/json" },
        body: JSON.stringify(badBody),
      });
      assert.equal(res.status, 400);
    }

    // 2. Mint scoped keys
    const mintKey = async (
      name: string,
      scopes: string[],
      expiresInDays?: number | null,
      cookie = ctx.cookie
    ) => {
      const res = await ctx.app.request("/api/api-keys", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name, scopes, expiresInDays }),
      });
      assert.equal(res.status, 201);
      return (await res.json()) as {
        apiKey: { id: string; name: string; key_prefix: string; scopes: string[]; expires_at: string | null };
        secret: string;
      };
    };

    const readKey = await mintKey("Reader", ["requests:read"]);
    const writeKey = await mintKey("Writer", ["requests:write"]);
    const tplKey = await mintKey("Templates", ["templates:read"]);
    const mcpKey = await mintKey("MCP Only", ["mcp:read"]);
    const allKey = await mintKey("All Scopes", [
      "requests:read",
      "requests:write",
      "templates:read",
      "mcp:read",
    ]);
    const shortKey = await mintKey("Short Lived", ["requests:read"], 1);

    assert.ok(readKey.secret.startsWith("gg_live_"));
    assert.equal(readKey.apiKey.key_prefix, readKey.secret.slice(0, 16));

    // Secret is SHA-256 hashed in SQLite and never returned again on GET /api/api-keys
    const dbRow = ctx.db.prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(readKey.apiKey.id) as {
      key_hash: string;
    };
    assert.equal(dbRow.key_hash, sha256Hex(readKey.secret));
    const listText = await (await ctx.app.request("/api/api-keys", { headers: { cookie: ctx.cookie } })).text();
    assert.equal(listText.includes(readKey.secret), false);
    assert.equal(listText.includes(dbRow.key_hash), false);

    // 3. Create a request with TFN + PDF using writeKey (audit logged as api_key)
    const createRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${writeKey.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "API Key Pack",
        clientName: "Taylor Reid",
        clientEmail: "taylor@example.com",
        sendInvite: false,
        items: [
          { section: "ID", label: "TFN", kind: "text", required: true, validator: "au_tfn_mod11" },
          { section: "Docs", label: "Bank PDF", kind: "file", required: true, allowedGroups: ["pdf"] },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const { id: reqId, portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const magicToken = portalUrl.split("/c/")[1];
    const items = ctx.store.listRequestItems(reqId);
    const tfnItem = items.find((i) => i.validator === "au_tfn_mod11")!;
    const fileItem = items.find((i) => i.kind === "file")!;

    // Client submits TFN + PDF
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
    const pdfForm = new FormData();
    pdfForm.append("file", new File([Buffer.from("%PDF-1.4\n%KEYTEST\n%%EOF\n")], "bank.pdf", { type: "application/pdf" }));
    const upRes = await ctx.app.request(`/api/client/${magicToken}/items/${fileItem.id}`, {
      method: "POST",
      body: pdfForm,
    });
    assert.equal(upRes.status, 200);
    const uploadId = ((await upRes.json()) as { uploads: Array<{ id: string }> }).uploads[0].id;

    // 4. Granular scope matrix
    // readKey: reads requests/detail (masked TFN only, NO portal_url magic token!), clients, validators; blocked on write & templates
    const detailRes = await ctx.app.request(`/api/requests/${reqId}`, {
      headers: { authorization: `Bearer ${readKey.secret}` },
    });
    assert.equal(detailRes.status, 200);
    const detailText = await detailRes.text();
    assert.equal(detailText.includes("876 543 210"), false);
    assert.equal(detailText.includes("****** 210"), true);
    assert.equal(detailText.includes(magicToken), false, "requests:read key must never receive raw portal magic token");
    const detailJson = JSON.parse(detailText) as {
      portalUrl: string;
      auditEvents: Array<{ actor: string; action: string }>;
    };
    assert.equal(detailJson.portalUrl, "");
    assert.ok(detailJson.auditEvents.some((e) => e.actor === "api_key" && e.action === "request.created"));

    // Key holding both requests:read and requests:write still sees portal_url
    const rwList = (await (
      await ctx.app.request("/api/requests", { headers: { authorization: `Bearer ${allKey.secret}` } })
    ).json()) as { requests: Array<{ id: string; portal_url: string }> };
    assert.ok(rwList.requests.find((r) => r.id === reqId)?.portal_url.includes(`/c/${magicToken}`));

    assert.equal(
      (await ctx.app.request("/api/clients", { headers: { authorization: `Bearer ${readKey.secret}` } })).status,
      200
    );
    assert.equal(
      (
        await ctx.app.request("/api/requests", {
          method: "POST",
          headers: { authorization: `Bearer ${readKey.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ title: "Nope", clientName: "X", clientEmail: "x@y.com", items: [] }),
        })
      ).status,
      403
    );
    assert.equal(
      (await ctx.app.request("/api/templates", { headers: { authorization: `Bearer ${readKey.secret}` } })).status,
      403
    );

    // Rate limit trips on 5th request for readKey (limit=4)
    const rateTripped = await ctx.app.request("/api/validators", {
      headers: { authorization: `Bearer ${readKey.secret}` },
    });
    assert.equal(rateTripped.status, 429);
    assert.ok(Number(rateTripped.headers.get("retry-after")) >= 1);

    // After window reset, GET /api/requests with requests:read also redacts portal_url and demoPortalUrl
    ctx.advanceTime(61_000);
    const readListRes = await ctx.app.request("/api/requests", {
      headers: { authorization: `Bearer ${readKey.secret}` },
    });
    assert.equal(readListRes.status, 200);
    const readListText = await readListRes.text();
    assert.equal(readListText.includes(magicToken), false);
    const readListJson = JSON.parse(readListText) as {
      requests: Array<{ id: string; portal_url: string }>;
      demoPortalUrl: string | null;
    };
    assert.equal(readListJson.requests.find((r) => r.id === reqId)?.portal_url, "");
    assert.equal(readListJson.demoPortalUrl, null);

    // tplKey: reads templates, blocked on POST /api/templates and GET /api/requests
    assert.equal(
      (await ctx.app.request("/api/templates", { headers: { authorization: `Bearer ${tplKey.secret}` } })).status,
      200
    );
    assert.equal(
      (
        await ctx.app.request("/api/templates", {
          method: "POST",
          headers: { authorization: `Bearer ${tplKey.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "Blocked", items: [{ label: "A", kind: "text" }] }),
        })
      ).status,
      403
    );
    assert.equal(
      (await ctx.app.request("/api/requests", { headers: { authorization: `Bearer ${tplKey.secret}` } })).status,
      403
    );

    // mcpKey: blocked from REST endpoints
    assert.equal(
      (await ctx.app.request("/api/requests", { headers: { authorization: `Bearer ${mcpKey.secret}` } })).status,
      403
    );
    assert.equal(
      (await ctx.app.request("/api/templates", { headers: { authorization: `Bearer ${mcpKey.secret}` } })).status,
      403
    );

    // 5. Session-only endpoints MUST refuse even an all-scopes API key with 403
    const sessionOnlyChecks: Array<[string, string]> = [
      ["GET", "/api/settings"],
      ["GET", "/api/api-keys"],
      ["POST", "/api/api-keys"],
      ["DELETE", `/api/api-keys/${readKey.apiKey.id}`],
      ["GET", "/api/settings/webhook/deliveries"],
      ["GET", "/api/outbox"],
      ["PUT", "/api/account"],
      ["POST", `/api/requests/${reqId}/items/${tfnItem.id}/reveal`],
      ["GET", `/api/uploads/${uploadId}/download`],
      ["GET", `/api/uploads/${uploadId}/preview`],
      ["GET", `/api/requests/${reqId}/export.zip`],
    ];
    for (const [method, url] of sessionOnlyChecks) {
      ctx.advanceTime(61_000); // keep rate limit clear across matrix checks
      const res = await ctx.app.request(url, {
        method,
        headers: { authorization: `Bearer ${allKey.secret}` },
      });
      assert.equal(res.status, 403, `Expected 403 for API key on session-only ${method} ${url}`);
    }

    // 6. Invalid Bearer never silently falls back to a valid session cookie
    const invalidWithCookie = await ctx.app.request("/api/requests", {
      headers: {
        cookie: ctx.cookie,
        authorization: "Bearer gg_live_invalid_token_value",
        "x-forwarded-for": "10.0.0.99",
      },
    });
    assert.equal(invalidWithCookie.status, 401);

    // Failed auth IP brute-force trips 429 on 4th attempt (limit=3)
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (
          await ctx.app.request("/api/requests", {
            headers: { authorization: "Bearer gg_live_bad", "x-forwarded-for": "10.0.0.99" },
          })
        ).status,
        401
      );
    }
    const authIpLimited = await ctx.app.request("/api/requests", {
      headers: { authorization: "Bearer gg_live_bad", "x-forwarded-for": "10.0.0.99" },
    });
    assert.equal(authIpLimited.status, 429);

    // 7. Cross-tenant isolation with API keys & key revocation
    const signupB = await ctx.app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Beta Firm",
        email: "beta@example.com",
        password: "beta-secure-password",
      }),
    });
    assert.equal(signupB.status, 200);
    const cookieB = extractCookie(signupB.headers.get("set-cookie"), "gg_session");
    const keyB = await mintKey("Beta All", ["requests:read", "requests:write", "templates:read"], null, cookieB);

    assert.equal(
      (
        await ctx.app.request(`/api/requests/${reqId}`, {
          headers: { authorization: `Bearer ${keyB.secret}` },
        })
      ).status,
      404
    );
    assert.equal(
      (
        await ctx.app.request(`/api/requests/${reqId}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${keyB.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ dueAt: null }),
        })
      ).status,
      404
    );
    assert.equal(
      (
        await ctx.app.request(`/api/api-keys/${readKey.apiKey.id}`, {
          method: "DELETE",
          headers: { cookie: cookieB },
        })
      ).status,
      404
    );

    // 8. Revocation & Expiry immediately invalidate tokens
    ctx.advanceTime(61_000);
    assert.equal(
      (await ctx.app.request("/api/requests", { headers: { authorization: `Bearer ${shortKey.secret}` } })).status,
      200
    );
    ctx.advanceTime(25 * 3600_000); // past 1-day expiry
    assert.equal(
      (await ctx.app.request("/api/requests", { headers: { authorization: `Bearer ${shortKey.secret}` } })).status,
      401
    );

    const revokeRes = await ctx.app.request(`/api/api-keys/${allKey.apiKey.id}`, {
      method: "DELETE",
      headers: { cookie: ctx.cookie },
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(
      (await ctx.app.request("/api/requests", { headers: { authorization: `Bearer ${allKey.secret}` } })).status,
      401
    );
  } finally {
    ctx.cleanup();
  }
});

test("Webhooks: all 6 lifecycle events, 5 exponential retries, dead-lettering, manual replay & cross-tenant isolation", async () => {
  let responder: (url: string, headers: Record<string, string>, body: string) => Response = () =>
    new Response("ok", { status: 200 });
  const received: Array<{ event: string; deliveryId: string; headers: Record<string, string>; body: string }> = [];

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? "");
    received.push({
      event: headers["x-gathergate-event"] || "",
      deliveryId: headers["x-gathergate-delivery"] || "",
      headers,
      body,
    });
    return responder(String(input), headers, body);
  }) as typeof fetch;

  const ctx = await bootApp({ multiTenant: true, fetchImpl: mockFetch });
  const whSecret = "whsec_wave1_retry_secret";

  try {
    // Configure workspace webhook
    assert.equal(
      (
        await ctx.app.request("/api/settings/webhook", {
          method: "PUT",
          headers: { cookie: ctx.cookie, "content-type": "application/json" },
          body: JSON.stringify({
            webhookUrl: "https://hooks.example.com/gathergate",
            webhookSecret: whSecret,
          }),
        })
      ).status,
      200
    );

    // 1. Create request with dueAt in 2 days and 1 sensitive TFN item
    const dueAt = new Date(ctx.nowMs() + 2 * 86400_000).toISOString();
    const createRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: ctx.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Lifecycle Webhook Pack",
        clientName: "Morgan Lee",
        clientEmail: "morgan@example.com",
        dueAt,
        sendInvite: false,
        items: [{ section: "ID", label: "TFN", kind: "text", required: true, validator: "au_tfn_mod11" }],
      }),
    });
    assert.equal(createRes.status, 201);
    const { id: reqId, portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const token = portalUrl.split("/c/")[1];
    const tfnItem = ctx.store.listRequestItems(reqId)[0];

    // 2. First portal open emits request.opened ONCE; second open does NOT duplicate
    assert.equal((await ctx.app.request(`/api/client/${token}`)).status, 200);
    assert.equal((await ctx.app.request(`/api/client/${token}`)).status, 200);
    assert.equal(received.filter((r) => r.event === "request.opened").length, 1);

    // 3. Overdue sweep emits request.overdue ONCE, then again only if due date updated & passed again
    ctx.advanceTime(3 * 86400_000);
    assert.equal(
      await runOverdueSweep({
        store: ctx.store,
        masterKey: ctx.config.masterKey,
        baseUrl: ctx.config.baseUrl,
        multiTenant: true,
        fetchImpl: mockFetch,
        nowIso: ctx.nowIso(),
      }),
      1
    );
    assert.equal(
      await runOverdueSweep({
        store: ctx.store,
        masterKey: ctx.config.masterKey,
        baseUrl: ctx.config.baseUrl,
        multiTenant: true,
        fetchImpl: mockFetch,
        nowIso: ctx.nowIso(),
      }),
      0
    );
    assert.equal(received.filter((r) => r.event === "request.overdue").length, 1);

    // 4. Client submits TFN -> emits item.submitted (MASKED TFN) + request.in_review
    assert.equal(
      (
        await ctx.app.request(`/api/client/${token}/items/${tfnItem.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "876543210" }),
        })
      ).status,
      200
    );
    const submittedEv = received.find((r) => r.event === "item.submitted");
    assert.ok(submittedEv);
    assert.equal(submittedEv.body.includes("876 543 210"), false);
    assert.equal(submittedEv.body.includes("****** 210"), true);
    assert.equal(received.filter((r) => r.event === "request.in_review").length, 1);

    // 5. Simulate receiver outage (HTTP 503) when approving -> exercises all 5 exponential retries -> dead_letter
    responder = () => new Response("service unavailable", { status: 503 });
    assert.equal(
      (
        await ctx.app.request(`/api/requests/${reqId}/approve-all-submitted`, {
          method: "POST",
          headers: { cookie: ctx.cookie },
        })
      ).status,
      200
    );

    const deliveriesAfterFail = (
      await (
        await ctx.app.request("/api/settings/webhook/deliveries", { headers: { cookie: ctx.cookie } })
      ).json()
    ) as { deliveries: Array<{ id: string; event: string; status: string; attempts: number; max_attempts: number; next_attempt_at: string | null }> };
    const completedDelivery = deliveriesAfterFail.deliveries.find((d) => d.event === "request.completed")!;
    assert.equal(completedDelivery.status, "retrying");
    assert.equal(completedDelivery.attempts, 1);
    assert.equal(completedDelivery.max_attempts, 6);
    assert.ok(completedDelivery.next_attempt_at);

    // Before backoff elapses, retry sweep processes 0 items
    const tooEarly = await runWebhookRetrySweep({
      store: ctx.store,
      masterKey: ctx.config.masterKey,
      multiTenant: true,
      fetchImpl: mockFetch,
      nowIso: new Date(ctx.nowMs() + 30_000).toISOString(),
    });
    assert.equal(tooEarly.processed, 0);

    // Step through all 5 exponential backoff delays -> lands in dead_letter after attempt 6
    for (let i = 0; i < WEBHOOK_RETRY_DELAYS_MS.length; i++) {
      ctx.advanceTime(WEBHOOK_RETRY_DELAYS_MS[i] + 1_000);
      const sweep = await runWebhookRetrySweep({
        store: ctx.store,
        masterKey: ctx.config.masterKey,
        multiTenant: true,
        fetchImpl: mockFetch,
        nowIso: ctx.nowIso(),
      });
      assert.equal(sweep.processed, 1);
      const row = ctx.store.getWebhookDeliveryById(completedDelivery.id)!;
      assert.equal(row.attempts, i + 2);
      if (i < WEBHOOK_RETRY_DELAYS_MS.length - 1) {
        assert.equal(row.status, "retrying");
      } else {
        assert.equal(row.status, "dead_letter");
        assert.equal(row.next_attempt_at, null);
      }
    }

    // Further retry sweeps ignore dead-lettered deliveries
    ctx.advanceTime(24 * 3600_000);
    assert.equal(
      (
        await runWebhookRetrySweep({
          store: ctx.store,
          masterKey: ctx.config.masterKey,
          multiTenant: true,
          fetchImpl: mockFetch,
          nowIso: ctx.nowIso(),
        })
      ).processed,
      0
    );

    // 6. Cross-tenant replay isolation
    const signupB = await ctx.app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "Other Firm",
        email: "other@example.com",
        password: "other-secure-password",
      }),
    });
    const cookieB = extractCookie(signupB.headers.get("set-cookie"), "gg_session");
    assert.equal(
      (
        await ctx.app.request(`/api/settings/webhook/deliveries/${completedDelivery.id}/replay`, {
          method: "POST",
          headers: { cookie: cookieB },
        })
      ).status,
      404
    );

    // 7. Receiver recovers -> manual replay succeeds with fresh timestamp & valid HMAC signature
    responder = () => new Response("ok", { status: 200 });
    const replayRes = await ctx.app.request(
      `/api/settings/webhook/deliveries/${completedDelivery.id}/replay`,
      { method: "POST", headers: { cookie: ctx.cookie } }
    );
    assert.equal(replayRes.status, 200);
    const replayJson = (await replayRes.json()) as {
      ok: boolean;
      delivery: { status: string; attempts: number; last_status_code: number };
    };
    assert.equal(replayJson.ok, true);
    assert.equal(replayJson.delivery.status, "delivered");
    assert.equal(replayJson.delivery.attempts, 7);
    assert.equal(replayJson.delivery.last_status_code, 200);

    const lastCall = received[received.length - 1];
    assert.equal(lastCall.event, "request.completed");
    assert.equal(lastCall.deliveryId, completedDelivery.id);
    const ts = lastCall.headers["x-gathergate-timestamp"];
    assert.equal(Number(ts), Math.floor(ctx.nowMs() / 1000));
    assert.equal(
      lastCall.headers["x-gathergate-signature"],
      `t=${ts},v1=${hmacSha256Hex(whSecret, `${ts}.${lastCall.body}`)}`
    );

    // 8. Purge sweep shreds pre-purge webhook payloads (no lingering client email/name) and emits metadata-only request.purged
    ctx.advanceTime(20 * 86400_000);
    const purged = await runPurgeSweep({
      store: ctx.store,
      storage: ctx.storage,
      masterKey: ctx.config.masterKey,
      baseUrl: ctx.config.baseUrl,
      multiTenant: true,
      fetchImpl: mockFetch,
      nowIso: ctx.nowIso(),
    });
    assert.equal(purged.requestsPurged, 1);
    const purgedEv = received.find((r) => r.event === "request.purged");
    assert.ok(purgedEv);
    assert.equal(purgedEv.body.includes("morgan@example.com"), false);
    assert.equal(purgedEv.body.includes("876 543 210"), false);

    // Pre-purge webhook_deliveries containing client_email/client_name must be shredded in SQLite
    const remainingForReq = ctx.db
      .prepare("SELECT event, payload_json FROM webhook_deliveries WHERE request_id = ?")
      .all(reqId) as Array<{ event: string; payload_json: string }>;
    assert.equal(remainingForReq.length, 1);
    assert.equal(remainingForReq[0].event, "request.purged");
    assert.equal(remainingForReq[0].payload_json.includes("morgan@example.com"), false);
    assert.equal(remainingForReq[0].payload_json.includes("Morgan Lee"), false);

    // All 6 lifecycle event types verified with valid HMAC signatures
    for (const expectedEvent of [
      "request.opened",
      "item.submitted",
      "request.in_review",
      "request.completed",
      "request.overdue",
      "request.purged",
    ]) {
      const match = received.find((r) => r.event === expectedEvent);
      assert.ok(match, `Missing expected webhook event ${expectedEvent}`);
      const evTs = match.headers["x-gathergate-timestamp"];
      assert.equal(
        match.headers["x-gathergate-signature"],
        `t=${evTs},v1=${hmacSha256Hex(whSecret, `${evTs}.${match.body}`)}`
      );
    }
  } finally {
    ctx.cleanup();
  }
});

test("Webhooks: DNS rebinding on retry/replay is blocked and marked dead_letter without outbound fetch", async () => {
  let fetchCalled = false;
  const mockFetch = (async () => {
    fetchCalled = true;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const ctx = await bootApp({
    multiTenant: true,
    fetchImpl: mockFetch,
    lookupImpl: async () => [{ address: "169.254.169.254", family: 4 }],
  });

  try {
    assert.equal(
      (
        await ctx.app.request("/api/settings/webhook", {
          method: "PUT",
          headers: { cookie: ctx.cookie, "content-type": "application/json" },
          body: JSON.stringify({
            webhookUrl: "https://rebind.example.com/hook",
            webhookSecret: "whsec_ssrf_test",
          }),
        })
      ).status,
      200
    );

    const createRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: ctx.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "SSRF Retry Check",
        clientName: "C",
        clientEmail: "c@example.com",
        sendInvite: false,
        items: [{ label: "Email", kind: "text", required: true, validator: "email" }],
      }),
    });
    const { portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const token = portalUrl.split("/c/")[1];
    assert.equal((await ctx.app.request(`/api/client/${token}`)).status, 200);

    assert.equal(fetchCalled, false);
    const listRes = (await (
      await ctx.app.request("/api/settings/webhook/deliveries", { headers: { cookie: ctx.cookie } })
    ).json()) as { deliveries: Array<{ id: string; status: string; last_error: string }> };
    assert.equal(listRes.deliveries.length, 1);
    assert.equal(listRes.deliveries[0].status, "dead_letter");
    assert.match(listRes.deliveries[0].last_error, /public https/i);

    // Replay also re-checks DNS and refuses outbound fetch
    const replay = await ctx.app.request(
      `/api/settings/webhook/deliveries/${listRes.deliveries[0].id}/replay`,
      { method: "POST", headers: { cookie: ctx.cookie } }
    );
    assert.equal(replay.status, 400);
    assert.equal(fetchCalled, false);
  } finally {
    ctx.cleanup();
  }
});

test("Webhooks: transient DNS stays retryable, concurrent claim prevents double POST, and status filter/pagination work", async () => {
  let dnsMode: "transient" | "public" = "transient";
  let slowRelease: (() => void) | null = null;
  let postCount = 0;

  const mockFetch = (async () => {
    postCount += 1;
    if (slowRelease) {
      await new Promise<void>((resolve) => {
        const done = slowRelease!;
        slowRelease = null;
        setTimeout(() => {
          done();
          resolve();
        }, 30);
      });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const ctx = await bootApp({
    multiTenant: true,
    fetchImpl: mockFetch,
    lookupImpl: async () => {
      if (dnsMode === "transient") {
        const err = new Error("temporary failure in name resolution") as NodeJS.ErrnoException;
        err.code = "EAI_AGAIN";
        throw err;
      }
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });

  try {
    assert.equal(
      (
        await ctx.app.request("/api/settings/webhook", {
          method: "PUT",
          headers: { cookie: ctx.cookie, "content-type": "application/json" },
          body: JSON.stringify({
            webhookUrl: "https://hooks.example.com/in",
            webhookSecret: "whsec_dns_retry",
          }),
        })
      ).status,
      200
    );

    const createRes = await ctx.app.request("/api/requests", {
      method: "POST",
      headers: { cookie: ctx.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Transient DNS Pack",
        clientName: "Dana",
        clientEmail: "dana@example.com",
        sendInvite: false,
        items: [{ label: "Email", kind: "text", required: true, validator: "email" }],
      }),
    });
    const { portalUrl } = (await createRes.json()) as { id: string; portalUrl: string };
    const token = portalUrl.split("/c/")[1];

    // Transient DNS EAI_AGAIN schedules retry instead of immediately dead-lettering
    assert.equal((await ctx.app.request(`/api/client/${token}`)).status, 200);
    const retryingRes = (await (
      await ctx.app.request("/api/settings/webhook/deliveries?status=retrying", {
        headers: { cookie: ctx.cookie },
      })
    ).json()) as { deliveries: Array<{ id: string; status: string }>; total: number; deadLetterCount: number };
    assert.equal(retryingRes.deliveries.length, 1);
    assert.equal(retryingRes.total, 1);
    assert.equal(retryingRes.deadLetterCount, 0);

    // DNS recovers -> overlapping retry sweeps claim atomically and send exactly 1 POST
    dnsMode = "public";
    ctx.advanceTime(WEBHOOK_RETRY_DELAYS_MS[0] + 5_000);
    slowRelease = () => {};
    const [s1, s2] = await Promise.all([
      runWebhookRetrySweep({
        store: ctx.store,
        masterKey: ctx.config.masterKey,
        multiTenant: true,
        fetchImpl: mockFetch,
        lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
        nowIso: ctx.nowIso(),
      }),
      runWebhookRetrySweep({
        store: ctx.store,
        masterKey: ctx.config.masterKey,
        multiTenant: true,
        fetchImpl: mockFetch,
        lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
        nowIso: ctx.nowIso(),
      }),
    ]);
    assert.equal(s1.processed + s2.processed, 1);
    assert.equal(postCount, 1);

    // Stale lease token cannot overwrite a reclaimed delivery row
    const completedId = retryingRes.deliveries[0].id;
    const staleWrite = ctx.store.completeWebhookDeliveryAttempt({
      id: completedId,
      claimToken: "stale-claim-token",
      targetUrl: "https://hooks.example.com/in",
      status: "dead_letter",
      attempts: 99,
      lastStatusCode: 500,
      lastError: "stale overwrite",
      nextAttemptAt: null,
      deliveredAt: null,
      nowIso: ctx.nowIso(),
    });
    assert.equal(staleWrite, undefined);
    assert.equal(ctx.store.getWebhookDeliveryById(completedId)?.status, "delivered");
  } finally {
    ctx.cleanup();
  }
});

test("Webhooks: postPinnedHttps connects strictly to pinned IP and preserves TLS SNI hostname", async () => {
  let receivedClientHello = Buffer.alloc(0);
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      receivedClientHello = Buffer.concat([receivedClientHello, chunk]);
      socket.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await assert.rejects(
      () =>
        postPinnedHttps({
          url: `https://pinned-sni.invalid:${port}/webhook`,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "webhook.test" }),
          resolvedAddresses: [{ address: "127.0.0.1", family: 4 }],
          timeoutMs: 3_000,
        }),
      /socket hang up|ECONNRESET|TLS|disconnected/i
    );
    assert.ok(receivedClientHello.byteLength > 20, "Expected TLS ClientHello on pinned IP socket");
    assert.equal(
      receivedClientHello.includes(Buffer.from("pinned-sni.invalid", "ascii")),
      true,
      "Expected TLS SNI extension to carry original hostname"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
