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

async function bootApp(extraConfig?: { manualReminderCooldownMs?: number; multiTenant?: boolean }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-m2-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    BASE_URL: "http://localhost:3080",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
    MULTI_TENANT: extraConfig?.multiTenant ? "true" : "false",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const email = new MemoryEmailAdapter();
  const { app, store } = createApp({
    config,
    db,
    storage: createStorageAdapter(config),
    email,
    manualReminderCooldownMs: extraConfig?.manualReminderCooldownMs,
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

  async function createRequest(items: unknown[], title = "FY26 pack") {
    const res = await json("POST", "/api/requests", {
      title,
      clientName: "Maya Patel",
      clientEmail: "maya@client.test",
      items,
      reminderIntervalDays: 3,
      maxReminders: 4,
    });
    assert.equal(res.status, 201);
    const { id, portalUrl } = (await res.json()) as { id: string; portalUrl: string };
    return { id, token: portalUrl.split("/c/")[1] };
  }

  return {
    app,
    db,
    store,
    email,
    json,
    createRequest,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Manual reminder now: sends email, logs audit, enforces cooldown, works when paused, checks status & IDOR", async () => {
  const { app, db, store, email, json, createRequest, cleanup } = await bootApp({ multiTenant: true });
  try {
    const { id, token } = await createRequest([
      { label: "ABN", kind: "text", required: true, validator: "au_abn_mod89" },
    ]);
    const [abnItem] = store.listRequestItems(id);

    // Works even when auto-chaser is paused
    assert.equal((await json("POST", `/api/requests/${id}/toggle-reminders`)).status, 200);

    const beforeEmails = email.sent.length;
    const first = await json("POST", `/api/requests/${id}/remind-now`);
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as { reminders_sent: number; last_manual_reminder_at: string };
    assert.equal(firstJson.reminders_sent, 1);
    assert.ok(firstJson.last_manual_reminder_at);
    assert.equal(email.sent.length, beforeEmails + 1);
    assert.match(email.sent.at(-1)!.subject, /^Reminder: 1 item left/);

    const outbox = (await (await json("GET", "/api/outbox")).json()) as {
      emails: Array<{ kind: string; request_id: string }>;
    };
    assert.ok(outbox.emails.some((e) => e.request_id === id && e.kind === "reminder"));

    const detail = (await (await json("GET", `/api/requests/${id}`)).json()) as {
      auditEvents: Array<{ action: string }>;
    };
    assert.ok(detail.auditEvents.some((ev) => ev.action === "reminder.manual_sent"));

    // Immediate retry hits 429 cooldown with Retry-After header
    const cooldownRes = await json("POST", `/api/requests/${id}/remind-now`);
    assert.equal(cooldownRes.status, 429);
    assert.ok(Number(cooldownRes.headers.get("retry-after")) >= 1);
    assert.equal(email.sent.length, beforeEmails + 1);

    // Backdating cooldown lets operator send again
    db.prepare("UPDATE requests SET last_manual_reminder_at = ? WHERE id = ?").run(
      new Date(Date.now() - 20 * 60_000).toISOString(),
      id
    );
    const second = await json("POST", `/api/requests/${id}/remind-now`);
    assert.equal(second.status, 200);
    assert.equal(email.sent.length, beforeEmails + 2);

    // Client submits ABN -> in_review -> 0 outstanding items returns 400
    await app.request(`/api/client/${token}/items/${abnItem.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "51824753556" }),
    });
    db.prepare("UPDATE requests SET last_manual_reminder_at = NULL WHERE id = ?").run(id);
    assert.equal((await json("POST", `/api/requests/${id}/remind-now`)).status, 400);

    // Approving completes request -> 409
    assert.equal(
      (await json("POST", `/api/requests/${id}/items/${abnItem.id}/review`, { decision: "approved" })).status,
      200
    );
    assert.equal((await json("POST", `/api/requests/${id}/remind-now`)).status, 409);

    // Cross-workspace IDOR -> 404
    const foreignSignup = await app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Other", email: "other@test.au", password: "password-1234" }),
    });
    const foreignCookie = foreignSignup.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];
    assert.equal((await json("POST", `/api/requests/${id}/remind-now`, undefined, foreignCookie)).status, 404);
  } finally {
    cleanup();
  }
});

test("Live request controls: edit due date and add checklist item", async () => {
  const { app, store, json, createRequest, cleanup } = await bootApp({ multiTenant: true });
  try {
    const { id, token } = await createRequest([
      { label: "ABN", kind: "text", required: true, validator: "au_abn_mod89" },
    ]);
    const [abnItem] = store.listRequestItems(id);

    // Update due date
    assert.equal((await json("PATCH", `/api/requests/${id}`, { dueAt: "not-a-date" })).status, 400);
    const dueIso = "2026-12-15T17:00:00.000Z";
    const upd = await json("PATCH", `/api/requests/${id}`, { dueAt: dueIso });
    assert.equal(upd.status, 200);
    assert.equal(((await upd.json()) as { due_at: string }).due_at, dueIso);

    // Clear due date
    const cleared = await json("PATCH", `/api/requests/${id}`, { dueAt: null });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { due_at: string | null }).due_at, null);

    // Submit initial item -> request transitions to in_review
    await app.request(`/api/client/${token}/items/${abnItem.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "51824753556" }),
    });
    assert.equal(store.getRequestById(store.getUserByEmail("ops@harbour.test")!.workspace_id, id)!.status, "in_review");

    // Unknown validator fails closed
    assert.equal(
      (
        await json("POST", `/api/requests/${id}/items`, {
          label: "Bad",
          kind: "text",
          required: true,
          validator: "xx_unknown",
        })
      ).status,
      400
    );

    // Adding a required item returns request from in_review -> open at max position + 1
    const addRes = await json("POST", `/api/requests/${id}/items`, {
      section: "Extra",
      label: "Supplier Invoice Photo",
      kind: "file",
      required: true,
      allowedGroups: ["pdf", "image"],
    });
    assert.equal(addRes.status, 201);
    const added = (await addRes.json()) as {
      requestStatus: string;
      item: { id: string; position: number; label: string; status: string };
    };
    assert.equal(added.requestStatus, "open");
    assert.equal(added.item.position, 1);
    assert.equal(added.item.status, "pending");

    // Client sees the new item on the live portal
    const portal = (await (await app.request(`/api/client/${token}`)).json()) as {
      items: Array<{ label: string }>;
    };
    assert.ok(portal.items.some((i) => i.label === "Supplier Invoice Photo"));

    // Complete request then confirm edits are blocked (409)
    await json("POST", `/api/requests/${id}/items/${abnItem.id}/review`, { decision: "approved" });
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%%EOF")], "inv.pdf", { type: "application/pdf" }));
    await app.request(`/api/client/${token}/items/${added.item.id}`, { method: "POST", body: fd });
    await json("POST", `/api/requests/${id}/items/${added.item.id}/review`, { decision: "approved" });

    assert.equal((await json("PATCH", `/api/requests/${id}`, { dueAt: dueIso })).status, 409);
    assert.equal(
      (
        await json("POST", `/api/requests/${id}/items`, {
          label: "Late item",
          kind: "text",
          required: false,
        })
      ).status,
      409
    );

    // Cross-workspace IDOR -> 404
    const foreignSignup = await app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Other", email: "other2@test.au", password: "password-1234" }),
    });
    const foreignCookie = foreignSignup.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];
    assert.equal((await json("PATCH", `/api/requests/${id}`, { dueAt: dueIso }, foreignCookie)).status, 404);
    assert.equal(
      (
        await json(
          "POST",
          `/api/requests/${id}/items`,
          { label: "X", kind: "text", required: false },
          foreignCookie
        )
      ).status,
      404
    );
  } finally {
    cleanup();
  }
});

test("Bulk reminders pause/resume: updates active packs, skips closed/foreign, validates payload", async () => {
  const { app, store, json, createRequest, cleanup } = await bootApp({ multiTenant: true });
  try {
    const r1 = await createRequest([{ label: "Doc 1", kind: "text", required: true }], "Req 1");
    const r2 = await createRequest([{ label: "Doc 2", kind: "text", required: true }], "Req 2");
    const rDone = await createRequest([{ label: "Doc 3", kind: "text", required: true }], "Req Done");
    const [doneItem] = store.listRequestItems(rDone.id);
    await app.request(`/api/client/${rDone.token}/items/${doneItem.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "done" }),
    });
    await json("POST", `/api/requests/${rDone.id}/items/${doneItem.id}/review`, { decision: "approved" });

    // Foreign request
    const foreignSignup = await app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Other", email: "other3@test.au", password: "password-1234" }),
    });
    const foreignCookie = foreignSignup.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];
    const foreignTpl = store.listTemplates(store.getUserByEmail("other3@test.au")!.workspace_id)[0];
    const foreignReqRes = await json(
      "POST",
      "/api/requests",
      {
        templateId: foreignTpl.id,
        title: "Foreign",
        clientName: "F",
        clientEmail: "f@test.au",
      },
      foreignCookie
    );
    const { id: foreignId } = (await foreignReqRes.json()) as { id: string };

    assert.equal((await json("POST", "/api/requests/bulk-reminders", { ids: [], paused: true })).status, 400);
    assert.equal((await json("POST", "/api/requests/bulk-reminders", { ids: [r1.id], paused: "yes" })).status, 400);

    const pauseRes = await json("POST", "/api/requests/bulk-reminders", {
      ids: [r1.id, r2.id, rDone.id, foreignId],
      paused: true,
    });
    assert.equal(pauseRes.status, 200);
    const pauseJson = (await pauseRes.json()) as { updatedIds: string[]; paused: boolean };
    assert.deepEqual(pauseJson.updatedIds.sort(), [r1.id, r2.id].sort());

    const wsId = store.getUserByEmail("ops@harbour.test")!.workspace_id;
    assert.equal(store.getRequestById(wsId, r1.id)!.reminders_paused, 1);
    assert.equal(store.getRequestById(wsId, r2.id)!.reminders_paused, 1);
    assert.equal(store.getRequestById(wsId, rDone.id)!.reminders_paused, 0);
    assert.equal(
      store.getRequestById(store.getUserByEmail("other3@test.au")!.workspace_id, foreignId)!.reminders_paused,
      0
    );

    const resumeRes = await json("POST", "/api/requests/bulk-reminders", {
      ids: [r1.id, r2.id],
      paused: false,
    });
    assert.equal(resumeRes.status, 200);
    assert.equal(store.getRequestById(wsId, r1.id)!.reminders_paused, 0);
    assert.equal(store.getRequestById(wsId, r2.id)!.reminders_paused, 0);
  } finally {
    cleanup();
  }
});

test("Templates: duplicate creates editable custom copy and GET returns workspace branding", async () => {
  const { app, json, cleanup } = await bootApp({ multiTenant: true });
  try {
    await json("PUT", "/api/settings/branding", {
      brandColor: "#1D4ED8",
      supportEmail: "help@harbour.test",
    });

    const listRes = await json("GET", "/api/templates");
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as {
      templates: Array<{ id: string; name: string; is_builtin: boolean; items: unknown[] }>;
      branding: { brandColor: string; supportEmail: string };
    };
    assert.equal(listJson.branding.brandColor, "#1D4ED8");
    assert.equal(listJson.branding.supportEmail, "help@harbour.test");

    const builtin = listJson.templates.find((t) => t.is_builtin)!;
    const dupRes = await json("POST", `/api/templates/${builtin.id}/duplicate`);
    assert.equal(dupRes.status, 201);
    const dupJson = (await dupRes.json()) as {
      template: { id: string; name: string; is_builtin: boolean; items: unknown[] };
    };
    assert.notEqual(dupJson.template.id, builtin.id);
    assert.equal(dupJson.template.name, `${builtin.name} (Copy)`);
    assert.equal(dupJson.template.is_builtin, false);
    assert.deepEqual(dupJson.template.items, builtin.items);

    // Custom copy can be deleted while built-in stays protected
    assert.equal((await json("DELETE", `/api/templates/${dupJson.template.id}`)).status, 200);
    assert.equal((await json("POST", `/api/templates/tpl_missing/duplicate`)).status, 404);

    // Foreign workspace cannot duplicate our template
    const foreignSignup = await app.request("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Other", email: "other4@test.au", password: "password-1234" }),
    });
    const foreignCookie = foreignSignup.headers.get("set-cookie")!.match(/gg_session=[^;]+/)![0];
    assert.equal((await json("POST", `/api/templates/${builtin.id}/duplicate`, {}, foreignCookie)).status, 404);
  } finally {
    cleanup();
  }
});
