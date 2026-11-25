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
import {
  contrastRatio,
  inviteEmail,
  isHexColor,
  otpEmail,
  readableTextOn,
  reminderEmail,
  revisionEmail,
  type EmailBrand,
} from "../src/emails/templates.js";
import { isKnownValidator, listValidators, SENSITIVE_VALIDATORS, validateTextValue } from "../src/validators/index.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

async function bootApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-m1-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    BASE_URL: "http://localhost:3080",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
  });
  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const email = new MemoryEmailAdapter();
  const { app, store } = createApp({ config, db, storage: createStorageAdapter(config), email });

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
      headers: { cookie: extraCookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  async function createRequest(items: unknown[]) {
    const res = await json("POST", "/api/requests", {
      title: "FY26 pack",
      clientName: "Claire <script>",
      clientEmail: "claire@client.test",
      items,
      reminderIntervalDays: 3,
      maxReminders: 3,
    });
    assert.equal(res.status, 201);
    const { id, portalUrl } = (await res.json()) as { id: string; portalUrl: string };
    return { id, token: portalUrl.split("/c/")[1] };
  }

  return { app, store, email, tmpDir, json, createRequest, cleanup: () => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
}

const brand: EmailBrand = {
  name: "Harbour & Co",
  color: "#0F5243",
  logoUrl: null,
  supportEmail: "help@harbour.test",
  supportPhone: null,
};

test("Validator packs: registry, generic IBAN/E.164, sensitive flags, unknown keys fail closed", () => {
  const keys = listValidators().map((v) => v.key);
  assert.equal(new Set(keys).size, keys.length, "validator keys must be unique");
  for (const k of ["none", "email", "url", "phone_e164", "iban", "au_abn_mod89", "au_tfn_mod11"]) {
    assert.ok(isKnownValidator(k), k);
  }
  assert.deepEqual([...SENSITIVE_VALIDATORS].sort(), ["au_medicare_mod10", "au_tfn_mod11", "uk_nino", "us_ssn"]);

  assert.deepEqual(validateTextValue("iban", "gb82 west 1234 5698 7654 32"), {
    valid: true,
    normalised: "GB82 WEST 1234 5698 7654 32",
  });
  assert.equal(validateTextValue("iban", "GB82 WEST 1234 5698 7654 33").valid, false);
  assert.deepEqual(validateTextValue("phone_e164", "+44 (20) 7946-0958"), { valid: true, normalised: "+442079460958" });
  assert.equal(validateTextValue("phone_e164", "020 7946 0958").valid, false);

  const unknown = validateTextValue("xx_made_up", "123");
  assert.equal(unknown.valid, false);
  assert.match(unknown.error!, /unknown validator/);
});

test("Branded emails: escaped content, plain-text fallback, CTA links, readable button colour", () => {
  const url = "http://localhost:3080/c/abc?x=1&y=2";
  const nasty = '<img src=x onerror="alert(1)">';
  const rendered = [
    inviteEmail({ brand, clientName: nasty, title: "FY26", portalUrl: url, itemCount: 3, welcomeNote: nasty, dueAt: "2026-12-01T00:00:00.000Z" }),
    otpEmail({ brand, clientName: nasty, title: "FY26", code: "123456" }),
    revisionEmail({ brand, clientName: nasty, title: "FY26", itemLabel: nasty, note: nasty, portalUrl: url }),
    reminderEmail({ brand, clientName: nasty, title: "FY26", portalUrl: url, outstanding: [{ label: nasty, needsRevision: true, note: nasty }] }),
  ];
  for (const email of rendered) {
    assert.ok(email.subject.length > 0 && email.subject.length < 90, email.subject);
    assert.ok(email.text.length > 0);
    assert.ok(!email.html.includes("<img src=x"), "untrusted HTML must be escaped");
    assert.ok(!/<script/i.test(email.html));
    assert.ok(!email.html.includes("\u2014") && !email.text.includes("\u2014"), "no em-dashes");
    assert.ok(email.html.includes("help@harbour.test"));
    assert.ok(email.html.includes("Harbour &amp; Co"));
  }
  for (const email of [rendered[0], rendered[2], rendered[3]]) {
    assert.ok(email.text.includes(url), "plain text carries the raw link");
    assert.ok(email.html.includes('href="http://localhost:3080/c/abc?x=1&amp;y=2"'));
  }
  assert.ok(rendered[1].text.includes("123456") && rendered[1].html.includes("123456"));

  assert.equal(readableTextOn("#0F5243"), "#FFFFFF");
  assert.equal(readableTextOn("#F5D90A"), "#11181C");
  assert.ok(contrastRatio("#000000", "#FFFFFF") > 20.9);
  assert.equal(isHexColor("#0f5243"), true);
  assert.equal(isHexColor("red"), false);
  assert.equal(isHexColor("#0f52431"), false);
});

test("Workspace branding: validation, logo sniffing, public logo route, portal + email theming", async () => {
  const { app, json, email, createRequest, cleanup } = await bootApp();
  try {
    assert.equal((await json("PUT", "/api/settings/branding", { brandColor: "teal" })).status, 400);
    assert.equal((await json("PUT", "/api/settings/branding", { supportEmail: "nope" })).status, 400);
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64")}`;
    assert.equal((await json("PUT", "/api/settings/branding", { logoDataUrl: svg })).status, 400);
    const big = `data:image/png;base64,${Buffer.concat([Buffer.from(PNG_1PX, "base64"), Buffer.alloc(210 * 1024)]).toString("base64")}`;
    assert.equal((await json("PUT", "/api/settings/branding", { logoDataUrl: big })).status, 400);
    assert.equal((await json("PUT", "/api/settings/branding", {})).status, 200, "empty update is allowed");
    assert.equal((await app.request("/api/settings/branding", { method: "PUT", body: "{}" })).status, 401);

    const ok = await json("PUT", "/api/settings/branding", {
      brandColor: "#1D4ED8",
      supportEmail: "help@harbour.test",
      supportPhone: "+61 3 9000 0000",
      // Declared type lies; the stored type must come from the bytes.
      logoDataUrl: `data:image/jpeg;base64,${PNG_1PX}`,
    });
    assert.equal(ok.status, 200);
    const branding = ((await ok.json()) as { branding: { logoDataUrl: string; brandColor: string } }).branding;
    assert.match(branding.logoDataUrl, /^data:image\/png;base64,/);
    assert.equal(branding.brandColor, "#1D4ED8");

    const session = (await (await json("GET", "/api/session")).json()) as { workspace: { id: string; has_logo: boolean } };
    assert.equal(session.workspace.has_logo, true);
    const logo = await app.request(`/api/public/workspaces/${session.workspace.id}/logo`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    assert.equal((await app.request("/api/public/workspaces/ws_missing/logo")).status, 404);

    const { token } = await createRequest([{ label: "ID", kind: "file", required: true }]);
    const portal = (await (await app.request(`/api/client/${token}`)).json()) as {
      branding: { brandColor: string; supportEmail: string; logoDataUrl: string };
    };
    assert.equal(portal.branding.brandColor, "#1D4ED8");
    assert.equal(portal.branding.supportEmail, "help@harbour.test");
    assert.ok(portal.branding.logoDataUrl);

    const invite = email.sent.at(-1)!;
    assert.ok(invite.html?.includes(`/api/public/workspaces/${session.workspace.id}/logo`), "email uses hosted logo URL");
    assert.ok(invite.html?.includes("#1D4ED8"));
    const outbox = (await (await json("GET", "/api/outbox")).json()) as { emails: Array<{ html_body: string | null }> };
    assert.ok(outbox.emails[0].html_body?.includes("<table"), "Local Outbox keeps the HTML version");

    const cleared = await json("PUT", "/api/settings/branding", { brandColor: null, logoDataUrl: null });
    assert.equal(((await cleared.json()) as { branding: { logoDataUrl: string | null } }).branding.logoDataUrl, null);
  } finally {
    cleanup();
  }
});

test("Templates and requests reject unknown validators", async () => {
  const { json, cleanup } = await bootApp();
  try {
    const res = await json("POST", "/api/templates", {
      name: "Bad",
      items: [{ label: "X", kind: "text", required: true, validator: "xx_made_up" }],
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /unknown validator/);
    const vals = (await (await json("GET", "/api/validators")).json()) as { validators: Array<{ key: string; pack: string }> };
    assert.ok(vals.validators.some((v) => v.key === "iban" && v.pack === "generic"));
    assert.ok(vals.validators.some((v) => v.key === "au_abn_mod89" && v.pack === "au"));
  } finally {
    cleanup();
  }
});

test("Client notes and Not applicable: validation, encryption, status transitions, locking", async () => {
  const { app, store, json, createRequest, cleanup } = await bootApp();
  try {
    const { id, token } = await createRequest([
      { label: "Health statement", kind: "file", required: true },
      { label: "ABN", kind: "text", required: true, validator: "au_abn_mod89" },
    ]);
    const [fileItem, abnItem] = store.listRequestItems(id);
    const put = (itemId: string, body: unknown) =>
      app.request(`/api/client/${token}/items/${itemId}/note`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await put(fileItem.id, { notApplicable: true })).status, 400, "N/A needs a reason");
    assert.equal((await put(fileItem.id, { note: "x".repeat(1001) })).status, 400);

    const noteOnly = await put(fileItem.id, { note: "Waiting on my insurer, will upload Friday" });
    assert.equal(noteOnly.status, 200);
    assert.equal(store.getRequestItem(id, fileItem.id)!.status, "pending", "a note alone does not submit");
    assert.ok(!store.getRequestItem(id, fileItem.id)!.client_note_encrypted!.includes("insurer"), "note is encrypted at rest");

    const na = await put(fileItem.id, { note: "No private health cover this year", notApplicable: true });
    assert.equal(na.status, 200);
    assert.equal(((await na.json()) as { item: { status: string } }).item.status, "submitted");

    const detail = (await (await json("GET", `/api/requests/${id}`)).json()) as {
      items: Array<{ id: string; client_na: boolean; client_note: string }>;
    };
    const opView = detail.items.find((i) => i.id === fileItem.id)!;
    assert.equal(opView.client_na, true);
    assert.equal(opView.client_note, "No private health cover this year");

    const undo = await put(fileItem.id, { note: "", notApplicable: false });
    assert.equal(((await undo.json()) as { item: { status: string } }).item.status, "pending");

    await app.request(`/api/client/${token}/items/${abnItem.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "51824753556" }),
    });
    await json("POST", `/api/requests/${id}/items/${abnItem.id}/review`, { decision: "approved" });
    assert.equal((await put(abnItem.id, { note: "too late" })).status, 409, "approved items are locked");
  } finally {
    cleanup();
  }
});

test("Client file delete and replace: blob shredded, status falls back, approved and foreign files protected", async () => {
  const { app, store, json, tmpDir, createRequest, cleanup } = await bootApp();
  try {
    const a = await createRequest([
      { label: "Statement", kind: "file", required: true, allowedGroups: ["pdf"] },
      { label: "Receipt", kind: "file", required: true, allowedGroups: ["pdf"] },
    ]);
    const b = await createRequest([{ label: "Other", kind: "file", required: true, allowedGroups: ["pdf"] }]);
    const [statement, receipt] = store.listRequestItems(a.id);
    const [other] = store.listRequestItems(b.id);

    async function upload(token: string, itemId: string, name: string) {
      const fd = new FormData();
      fd.append("file", new File([PDF_BYTES], name, { type: "application/pdf" }));
      const res = await app.request(`/api/client/${token}/items/${itemId}`, { method: "POST", body: fd });
      assert.equal(res.status, 200);
      return ((await res.json()) as { uploads: Array<{ id: string }> }).uploads[0].id;
    }

    const first = await upload(a.token, statement.id, "march.pdf");
    const blobPath = path.join(tmpDir, "blobs", store.getUploadForRequest(a.id, first)!.storage_key);
    assert.ok(fs.existsSync(blobPath));
    assert.equal(store.getRequestItem(a.id, statement.id)!.status, "submitted");

    const del = (token: string, uploadId: string) =>
      app.request(`/api/client/${token}/uploads/${uploadId}`, { method: "DELETE" });

    const foreign = await upload(b.token, other.id, "other.pdf");
    assert.equal((await del(a.token, foreign)).status, 404, "cannot delete another request's file");

    const removed = await del(a.token, first);
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { item: { status: string } }).item.status, "pending");
    assert.equal(fs.existsSync(blobPath), false, "encrypted blob shredded");
    assert.equal(store.getUploadForRequest(a.id, first), undefined);

    // Replace = delete then upload again.
    await upload(a.token, statement.id, "march-v2.pdf");
    assert.equal(store.getRequestItem(a.id, statement.id)!.status, "submitted");

    const locked = await upload(a.token, receipt.id, "receipt.pdf");
    await json("POST", `/api/requests/${a.id}/items/${receipt.id}/review`, { decision: "approved" });
    assert.equal((await del(a.token, locked)).status, 409, "approved files are locked");
  } finally {
    cleanup();
  }
});
