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

async function bootMultiApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-clients-"));
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
  const { app } = createApp({
    config,
    db,
    storage: createStorageAdapter(config),
    email: new MemoryEmailAdapter(),
  });

  const setup = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceName: "Spine & Strength Chiropractic",
      email: "ahmed@spine.test",
      password: "correct-horse-battery",
      loadDemo: false,
    }),
  });
  assert.equal(setup.status, 200);
  const cookieA = setup.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];

  const signup = await app.request("/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceName: "Other Practice",
      email: "other@firm.test",
      password: "other-firm-password",
    }),
  });
  assert.equal(signup.status, 200);
  const cookieB = signup.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];

  const req = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: {
        cookie,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  return {
    app,
    cookieA,
    cookieB,
    req,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Clients directory aggregates repeat requests by email, exposes awaitingReviewCount, and isolates tenants", async () => {
  const ctx = await bootMultiApp();
  try {
    // 1. Create two packs for the same client (mixed case email) and one pack in Workspace B
    const p1 = await ctx.req(ctx.cookieA, "POST", "/api/requests", {
      title: "Q1 Intake",
      clientName: "Marcus Okafor",
      clientEmail: "Marcus.Okafor@example.com.au",
      sendInvite: false,
      items: [{ label: "ABN", kind: "text", required: true, validator: "au_abn_mod89" }],
    });
    assert.equal(p1.status, 201);
    const pack1 = (await p1.json()) as { id: string; portalUrl: string };

    const p2 = await ctx.req(ctx.cookieA, "POST", "/api/requests", {
      title: "Q2 Follow-up",
      clientName: "Marcus Okafor",
      clientEmail: "marcus.okafor@example.com.au",
      sendInvite: false,
      items: [{ label: "Consent", kind: "checkbox", required: true }],
    });
    assert.equal(p2.status, 201);
    const pack2 = (await p2.json()) as { id: string; portalUrl: string };

    const foreign = await ctx.req(ctx.cookieB, "POST", "/api/requests", {
      title: "Foreign Pack",
      clientName: "Secret Client",
      clientEmail: "secret@other.test",
      sendInvite: false,
      items: [{ label: "ID", kind: "checkbox", required: true }],
    });
    assert.equal(foreign.status, 201);

    // 2. Client submits item on pack 1 -> awaitingReviewCount becomes 1; approve pack 2 -> completedRequests becomes 1
    const d1 = (await (await ctx.req(ctx.cookieA, "GET", `/api/requests/${pack1.id}`)).json()) as {
      items: Array<{ id: string }>;
    };
    const token1 = pack1.portalUrl.split("/c/")[1];
    const sub1 = await ctx.app.request(`/api/client/${token1}/items/${d1.items[0].id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "51824753556" }),
    });
    assert.equal(sub1.status, 200);

    const d2 = (await (await ctx.req(ctx.cookieA, "GET", `/api/requests/${pack2.id}`)).json()) as {
      items: Array<{ id: string }>;
    };
    const token2 = pack2.portalUrl.split("/c/")[1];
    await ctx.app.request(`/api/client/${token2}/items/${d2.items[0].id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    const app2 = await ctx.req(ctx.cookieA, "POST", `/api/requests/${pack2.id}/items/${d2.items[0].id}/review`, {
      decision: "approved",
    });
    assert.equal(app2.status, 200);

    // 3. Session readiness reflects awaitingReviewCount = 1
    const sessionRes = await ctx.req(ctx.cookieA, "GET", "/api/session");
    const session = (await sessionRes.json()) as { readiness: { awaitingReviewCount: number } };
    assert.equal(session.readiness.awaitingReviewCount, 1);

    // 4. GET /api/clients returns aggregated Marcus row and excludes Workspace B's Secret Client
    const clientsRes = await ctx.req(ctx.cookieA, "GET", "/api/clients");
    assert.equal(clientsRes.status, 200);
    const { clients } = (await clientsRes.json()) as {
      clients: Array<{
        email: string;
        name: string;
        totalRequests: number;
        activeRequests: number;
        awaitingReviewRequests: number;
        completedRequests: number;
        requests: Array<{ id: string; title: string }>;
      }>;
    };
    assert.equal(clients.length, 1);
    assert.equal(clients[0].email, "marcus.okafor@example.com.au");
    assert.equal(clients[0].totalRequests, 2);
    assert.equal(clients[0].activeRequests, 1);
    assert.equal(clients[0].awaitingReviewRequests, 1);
    assert.equal(clients[0].completedRequests, 1);
    assert.equal(clients[0].requests.length, 2);

    const unauth = await ctx.app.request("/api/clients");
    assert.equal(unauth.status, 401);
  } finally {
    ctx.cleanup();
  }
});
