import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryEmailAdapter } from "../src/adapters/email.js";
import { createStorageAdapter } from "../src/adapters/storage.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { runPurgeSweep } from "../src/jobs/purge.js";

function extractCookie(setCookieHeader: string | null, name: string): string {
  assert.ok(setCookieHeader, `Expected Set-Cookie header containing ${name}`);
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Cookie ${name} not found in ${setCookieHeader}`);
  return `${name}=${match[1]}`;
}

interface RecordedS3Request {
  method: string;
  pathname: string;
  key: string;
  authorization: string;
  xAmzDate: string;
}

test("loadConfig fails closed when STORAGE_BACKEND=s3 misses required S3 variables", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-s3-cfg-"));
  const masterKey = crypto.randomBytes(32).toString("hex");
  const baseEnv: Record<string, string> = {
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: masterKey,
    STORAGE_BACKEND: "s3",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_BUCKET: "gathergate-test",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
  };

  try {
    for (const missingKey of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ] as const) {
      const env = { ...baseEnv };
      delete env[missingKey];
      assert.throws(
        () => loadConfig(env),
        /S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY/,
        `Expected loadConfig to reject missing ${missingKey}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("STORAGE_BACKEND=s3 end-to-end: SigV4 PUT/GET/DELETE, encrypted S3 bytes, client delete, purge sweep, and 404/500 handling", async () => {
  const bucket = "gathergate-test";
  const objects = new Map<string, Buffer>();
  const requests: RecordedS3Request[] = [];
  let forceDeleteStatus: number | null = null;

  const s3Server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const authorization = String(req.headers.authorization || "");
    const xAmzDate = String(req.headers["x-amz-date"] || "");

    if (!/^AWS4-HMAC-SHA256 /.test(authorization) || !/^\d{8}T\d{6}Z$/.test(xAmzDate)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Missing SigV4 headers");
      return;
    }

    const prefix = `/${bucket}/`;
    if (!pathname.startsWith(prefix)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Bucket not found");
      return;
    }

    const key = pathname
      .slice(prefix.length)
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");

    requests.push({ method, pathname, key, authorization, xAmzDate });

    if (method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"mock-etag"' });
      res.end();
      return;
    }

    if (method === "GET") {
      const data = objects.get(key);
      if (!data) {
        res.writeHead(404);
        res.end("NoSuchKey");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(data.byteLength),
      });
      res.end(data);
      return;
    }

    if (method === "DELETE") {
      if (forceDeleteStatus !== null) {
        res.writeHead(forceDeleteStatus);
        res.end("Forced error");
        return;
      }
      if (!objects.has(key)) {
        res.writeHead(404);
        res.end("NoSuchKey");
        return;
      }
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  const addr = s3Server.address();
  assert.ok(addr && typeof addr === "object");
  const endpoint = `http://127.0.0.1:${addr.port}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-s3-e2e-"));
  const masterKeyHex = crypto.randomBytes(32).toString("hex");
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: masterKeyHex,
    BASE_URL: "http://localhost:3080",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "s3",
    S3_ENDPOINT: `${endpoint}/`,
    S3_REGION: "auto",
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
  });

  const db = openDatabase(path.join(tmpDir, "test.sqlite"));
  const storage = createStorageAdapter(config);
  const email = new MemoryEmailAdapter();
  const { app, store } = createApp({ config, db, storage, email });

  try {
    // 1. Setup workspace & create a 1-item request without OTP
    const setupRes = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "S3 Smoke Advisory",
        email: "ops@s3smoke.example.com.au",
        password: "super-secure-password-123",
        loadDemo: false,
      }),
    });
    assert.equal(setupRes.status, 200);
    const opCookie = extractCookie(setupRes.headers.get("set-cookie"), "gg_session");

    const tplRes = await app.request("/api/templates", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "S3 Single PDF Template",
        description: "Single file upload pack",
        items: [
          {
            section: "Documents",
            label: "Tax Statement PDF",
            kind: "file",
            required: true,
            allowedGroups: ["pdf"],
            multiple: true,
          },
        ],
      }),
    });
    assert.equal(tplRes.status, 201);
    const { template } = (await tplRes.json()) as { template: { id: string } };

    const reqRes = await app.request("/api/requests", {
      method: "POST",
      headers: { cookie: opCookie, "content-type": "application/json" },
      body: JSON.stringify({
        templateId: template.id,
        title: "S3 Storage Pack",
        clientName: "Alex Mercer",
        clientEmail: "alex@example.com.au",
        requireOtp: false,
        sendInvite: false,
        purgeAfterDays: 14,
      }),
    });
    assert.equal(reqRes.status, 201);
    const { id: requestId, portalUrl } = (await reqRes.json()) as { id: string; portalUrl: string };
    const magicToken = portalUrl.split("/c/")[1];
    const items = store.listRequestItems(requestId);
    assert.equal(items.length, 1);
    const fileItem = items[0];

    // 2. Client uploads valid PDF -> S3 PUT with SigV4 headers & ciphertext, local blobs dir empty
    const pdfPayload = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Title (S3 Confidential Statement) >>\nendobj\n%%EOF");
    const uploadForm = new FormData();
    uploadForm.append("file", new File([pdfPayload], "statement-q3.pdf", { type: "application/pdf" }));
    const uploadRes = await app.request(`/api/client/${magicToken}/items/${fileItem.id}`, {
      method: "POST",
      body: uploadForm,
    });
    assert.equal(uploadRes.status, 200);
    const uploadJson = (await uploadRes.json()) as { uploads: Array<{ id: string }> };
    assert.equal(uploadJson.uploads.length, 1);

    const firstUpload = store.listUploadsForRequest(requestId)[0];
    assert.ok(firstUpload);
    const putReq = requests.find((r) => r.method === "PUT" && r.key === firstUpload.storage_key);
    assert.ok(putReq, "Expected S3 PUT request for uploaded object");
    assert.match(putReq.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
    assert.match(putReq.xAmzDate, /^\d{8}T\d{6}Z$/);
    assert.equal(putReq.pathname, `/${bucket}/${firstUpload.storage_key.split("/").map(encodeURIComponent).join("/")}`);

    const storedCiphertext = objects.get(firstUpload.storage_key);
    assert.ok(storedCiphertext);
    assert.notEqual(storedCiphertext.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.equal(storedCiphertext.includes(Buffer.from("S3 Confidential Statement")), false);

    const localBlobsDir = path.join(tmpDir, "blobs");
    assert.equal(
      fs.existsSync(localBlobsDir) ? fs.readdirSync(localBlobsDir).length : 0,
      0,
      "Local blobs directory must remain empty when STORAGE_BACKEND=s3"
    );

    // 3. Operator downloads via API -> S3 GET with SigV4 headers, API returns exact plaintext PDF
    const downloadRes = await app.request(`/api/uploads/${firstUpload.id}/download`, {
      headers: { cookie: opCookie },
    });
    assert.equal(downloadRes.status, 200);
    const getReq = requests.find((r) => r.method === "GET" && r.key === firstUpload.storage_key);
    assert.ok(getReq, "Expected S3 GET request during operator download");
    assert.match(getReq.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
    assert.match(getReq.xAmzDate, /^\d{8}T\d{6}Z$/);

    const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepEqual(downloadedBytes, pdfPayload);

    // 4. Client deletes upload -> S3 DELETE removes object and getStream rejects
    const clientDelRes = await app.request(`/api/client/${magicToken}/uploads/${firstUpload.id}`, {
      method: "DELETE",
    });
    assert.equal(clientDelRes.status, 200);
    const clientDelReq = requests.find((r) => r.method === "DELETE" && r.key === firstUpload.storage_key);
    assert.ok(clientDelReq, "Expected S3 DELETE request on client upload deletion");
    assert.match(clientDelReq.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
    assert.equal(objects.has(firstUpload.storage_key), false);
    await assert.rejects(() => storage.getStream(firstUpload.storage_key), /S3 GET failed \(404\)/);

    // 5. Re-upload, approve to complete request, then runPurgeSweep -> S3 DELETE removes object
    const reuploadForm = new FormData();
    reuploadForm.append("file", new File([pdfPayload], "statement-q3-final.pdf", { type: "application/pdf" }));
    const reuploadRes = await app.request(`/api/client/${magicToken}/items/${fileItem.id}`, {
      method: "POST",
      body: reuploadForm,
    });
    assert.equal(reuploadRes.status, 200);
    const secondUpload = store.listUploadsForRequest(requestId)[0];
    assert.ok(secondUpload);
    assert.equal(objects.has(secondUpload.storage_key), true);

    const approveRes = await app.request(`/api/requests/${requestId}/approve-all-submitted`, {
      method: "POST",
      headers: { cookie: opCookie },
    });
    assert.equal(approveRes.status, 200);

    const futureIso = new Date(Date.now() + 30 * 86400_000).toISOString();
    const purgeResult = await runPurgeSweep({ store, storage, nowIso: futureIso });
    assert.equal(purgeResult.requestsPurged, 1);
    assert.equal(purgeResult.filesDeleted, 1);

    const purgeDelReq = requests.find((r) => r.method === "DELETE" && r.key === secondUpload.storage_key);
    assert.ok(purgeDelReq, "Expected S3 DELETE request during runPurgeSweep");
    assert.match(purgeDelReq.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
    assert.equal(objects.has(secondUpload.storage_key), false);
    await assert.rejects(() => storage.getStream(secondUpload.storage_key), /S3 GET failed \(404\)/);

    // 6. delete(missingKey) treats 404 as success and rejects on 500
    await storage.delete("missing/already-gone.enc");
    forceDeleteStatus = 500;
    await assert.rejects(() => storage.delete("missing/server-error.enc"), /S3 DELETE failed \(500\)/);
  } finally {
    forceDeleteStatus = null;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    s3Server.closeAllConnections?.();
    await new Promise<void>((resolve) => s3Server.close(() => resolve()));
  }
});
