import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { serve } from "@hono/node-server";
import { MemoryEmailAdapter } from "../src/adapters/email.js";
import { createStorageAdapter } from "../src/adapters/storage.js";
import { createApp } from "../src/app.js";
import {
  generateClientSetup,
  getPackageVersion,
  runCli,
  runDoctor,
  runMcpStdioBridge,
  SUPPORTED_SETUP_CLIENTS,
  writeClientConfig,
} from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";

function extractCookie(setCookieHeader: string | null, name: string): string {
  assert.ok(setCookieHeader, `Expected Set-Cookie containing ${name}`);
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Cookie ${name} missing in ${setCookieHeader}`);
  return `${name}=${match[1]}`;
}

function captureStream() {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  return {
    stream,
    text: () => chunks.join(""),
  };
}

const TSX_IMPORT = import.meta.resolve("tsx");

function spawnCliProcess(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; stdinText?: string }
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = process.execPath;
  const fullArgs = ["--import", TSX_IMPORT, path.resolve("src", "index.ts"), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, fullArgs, {
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options?.stdinText !== undefined) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}

async function bootLiveTcpGatherGate() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-cli-srv-"));
  const masterKeyHex = crypto.randomBytes(32).toString("hex");
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    MASTER_KEY: masterKeyHex,
    BASE_URL: "http://127.0.0.1:3080",
    EMAIL_BACKEND: "console",
    STORAGE_BACKEND: "local",
    MULTI_TENANT: "false",
  });
  const db = openDatabase(path.join(tmpDir, "gathergate.sqlite"));
  const storage = createStorageAdapter(config);
  const email = new MemoryEmailAdapter();
  const { app } = createApp({ config, db, storage, email });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  config.baseUrl = baseUrl;

  const setupRes = await fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceName: "CLI Advisory",
      email: "ops@cli.test",
      password: "cli-secure-password",
      loadDemo: false,
    }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = extractCookie(setupRes.headers.get("set-cookie"), "gg_session");

  const mintKey = async (name: string, scopes: string[]) => {
    const res = await fetch(`${baseUrl}/api/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name, scopes }),
    });
    assert.equal(res.status, 201);
    return (await res.json()) as { apiKey: { id: string }; secret: string };
  };

  return {
    tmpDir,
    masterKeyHex,
    baseUrl,
    mintKey,
    cleanup: () => {
      server.close();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("CLI: --help, --version, unknown command fail-closed, and zero DATA_DIR mutation", async () => {
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-cli-help-"));
  try {
    const helpRes = await spawnCliProcess(["--help"], { cwd: emptyCwd, env: { PATH: process.env.PATH } });
    assert.equal(helpRes.code, 0);
    assert.match(helpRes.stdout, /GatherGate v/);
    assert.match(helpRes.stdout, /doctor/);
    assert.match(helpRes.stdout, /setup/);
    assert.match(helpRes.stdout, /\bmcp\b/);
    assert.equal(fs.existsSync(path.join(emptyCwd, "data")), false, "--help must never create ./data");

    const verRes = await spawnCliProcess(["--version"], { cwd: emptyCwd, env: { PATH: process.env.PATH } });
    assert.equal(verRes.code, 0);
    assert.equal(verRes.stdout.trim(), getPackageVersion());

    const badCmd = await spawnCliProcess(["doctro"], { cwd: emptyCwd, env: { PATH: process.env.PATH } });
    assert.equal(badCmd.code, 1);
    assert.match(badCmd.stderr, /Unknown command "doctro"/);
    assert.equal(fs.existsSync(path.join(emptyCwd, "data")), false, "unknown command must never boot server");
  } finally {
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  }
});

test("CLI doctor: read-only diagnostics, live health + MCP probe, error states, and zero secret leakage", async () => {
  const live = await bootLiveTcpGatherGate();
  const missingDataDir = path.join(os.tmpdir(), `gathergate-doctor-missing-${Date.now()}`);
  try {
    // 1. Read-only check on nested nonexistent DATA_DIR must NOT create it and must warn (not fail)
    const nestedMissing = path.join(missingDataDir, "nested", "vault");
    const dryReport = await runDoctor({
      env: { DATA_DIR: nestedMissing, BASE_URL: "http://127.0.0.1:1" },
    });
    assert.equal(fs.existsSync(missingDataDir), false, "doctor must never create DATA_DIR");
    assert.equal(dryReport.checks.find((c) => c.name === "data_dir")?.status, "warn");
    assert.equal(dryReport.checks.find((c) => c.name === "master_key")?.status, "warn");

    // Malformed GATHERGATE_API_KEY (embedded newline) fails cleanly without echoing raw secret
    const badPasteKey = "gg_live_SUPER_SECRET\r\nLEAK_CHECK";
    const badPasteReport = await runDoctor({
      url: live.baseUrl,
      env: { DATA_DIR: live.tmpDir, MASTER_KEY: live.masterKeyHex, GATHERGATE_API_KEY: badPasteKey },
    });
    assert.equal(badPasteReport.ok, false);
    assert.equal(JSON.stringify(badPasteReport).includes("SUPER_SECRET"), false);
    assert.match(badPasteReport.checks.find((c) => c.name === "remote_mcp")?.detail || "", /invalid characters/i);

    // 2. Healthy live server + scoped MCP key -> all checks ok and zero secret echoed
    const mcpKey = await live.mintKey("Doctor Key", ["mcp:read"]);
    const out = captureStream();
    const err = captureStream();
    const okCode = await runCli(["doctor", "--url", live.baseUrl, "--json"], {
      stdout: out.stream,
      stderr: err.stream,
      env: {
        DATA_DIR: live.tmpDir,
        MASTER_KEY: live.masterKeyHex,
        GATHERGATE_API_KEY: mcpKey.secret,
      },
    });
    assert.equal(okCode, 0);
    const jsonText = out.text();
    assert.equal(jsonText.includes(live.masterKeyHex), false, "doctor must never echo MASTER_KEY");
    assert.equal(jsonText.includes(mcpKey.secret), false, "doctor must never echo GATHERGATE_API_KEY");
    const parsed = JSON.parse(jsonText) as { ok: boolean; checks: Array<{ name: string; status: string; detail: string }> };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.checks.find((c) => c.name === "remote_health")?.status, "ok");
    const mcpCheck = parsed.checks.find((c) => c.name === "remote_mcp");
    assert.equal(mcpCheck?.status, "ok");
    assert.match(mcpCheck?.detail || "", /7 tools/);
    assert.match(mcpCheck?.detail || "", /2026-07-28/);

    // 3. Key lacking mcp:read scope fails remote_mcp with clear scope hint
    const restKey = await live.mintKey("REST Only", ["requests:read"]);
    const noScope = await runDoctor({
      url: live.baseUrl,
      env: {
        DATA_DIR: live.tmpDir,
        MASTER_KEY: live.masterKeyHex,
        GATHERGATE_API_KEY: restKey.secret,
      },
    });
    assert.equal(noScope.ok, false);
    assert.equal(noScope.checks.find((c) => c.name === "remote_mcp")?.status, "fail");
    assert.match(noScope.checks.find((c) => c.name === "remote_mcp")?.detail || "", /mcp:read/);

    // 4. Invalid explicit key and invalid MASTER_KEY fail closed
    const badKeyReport = await runDoctor({
      url: live.baseUrl,
      env: {
        DATA_DIR: live.tmpDir,
        MASTER_KEY: "not-hex",
        GATHERGATE_API_KEY: "gg_live_invalid_secret",
      },
    });
    assert.equal(badKeyReport.ok, false);
    assert.equal(badKeyReport.checks.find((c) => c.name === "master_key")?.status, "fail");
    assert.equal(badKeyReport.checks.find((c) => c.name === "remote_mcp")?.status, "fail");

    // 5. Explicit unreachable --url fails remote_health
    const unreachable = await runDoctor({
      url: "http://127.0.0.1:1",
      env: { DATA_DIR: live.tmpDir, MASTER_KEY: live.masterKeyHex },
    });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.checks.find((c) => c.name === "remote_health")?.status, "fail");
  } finally {
    live.cleanup();
    fs.rmSync(missingDataDir, { recursive: true, force: true });
  }
});

test("CLI setup: generates configs for all 9 clients, supports mcp setup alias, and safely merges JSON on --write", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-setup-"));
  try {
    // 1. Every supported client generates clean config for both stdio and http
    for (const client of SUPPORTED_SETUP_CLIENTS) {
      for (const transport of ["stdio", "http"] as const) {
        const res = generateClientSetup({
          client,
          url: "https://intake.harbour.com.au/mcp/",
          transport,
        });
        assert.ok(res.snippet.length > 20, `Empty snippet for ${client}/${transport}`);
        if (transport === "stdio") {
          assert.match(res.snippet, /gathergate/);
          assert.match(res.snippet, res.format === "cli" ? /\bgathergate mcp\b/ : /"mcp"/);
          assert.equal(res.snippet.includes("/mcp/"), false);
        } else {
          assert.match(res.snippet, /https:\/\/intake\.harbour\.com\.au\/mcp/);
        }
        if (res.format === "json") {
          assert.doesNotThrow(() => JSON.parse(res.snippet), `Invalid JSON snippet for ${client}/${transport}`);
        }
      }
    }

    // Claude Desktop http mode refuses --write (claude_desktop_config.json is stdio-only)
    const claudeHttp = generateClientSetup({
      client: "claude-desktop",
      url: "https://intake.harbour.com.au",
      transport: "http",
    });
    assert.equal(claudeHttp.format, "text");
    assert.throws(() => writeClientConfig(claudeHttp, path.join(tmpDir, "nope.json")), /JSON MCP configs only/);

    // Zed stdio uses flat { command, args, env } schema
    const zedStdio = generateClientSetup({
      client: "zed",
      url: "https://intake.harbour.com.au",
      transport: "stdio",
    });
    const zedParsed = JSON.parse(zedStdio.snippet) as { context_servers: { gathergate: { command: unknown } } };
    assert.equal(zedParsed.context_servers.gathergate.command, "npx");

    // URL query/hash rejected fail-closed
    assert.throws(
      () => generateClientSetup({ client: "cursor", url: "https://intake.harbour.com.au/?a=1", transport: "http" }),
      /query parameters or fragments/
    );

    // 2. Codex stdio puts env_vars under [mcp_servers.gathergate], not [mcp_servers.gathergate.env]
    const codexStdio = generateClientSetup({
      client: "codex",
      url: "https://intake.harbour.com.au",
      transport: "stdio",
    });
    const envHeaderIdx = codexStdio.snippet.indexOf("[mcp_servers.gathergate.env]");
    const envVarsIdx = codexStdio.snippet.indexOf('env_vars = ["GATHERGATE_API_KEY"]');
    assert.ok(envVarsIdx > 0 && envVarsIdx < envHeaderIdx);

    // 3. --write merges into existing JSON config without clobbering sibling servers
    const targetConfig = path.join(tmpDir, "claude_desktop_config.json");
    fs.writeFileSync(
      targetConfig,
      JSON.stringify({ mcpServers: { existing: { command: "echo", args: ["ok"] } } }, null, 2)
    );
    const out = captureStream();
    const err = captureStream();
    const code = await runCli(
      ["mcp", "setup", "--client", "claude-desktop", "--url", "https://intake.harbour.com.au", "--write", "--config-path", targetConfig],
      { stdout: out.stream, stderr: err.stream }
    );
    assert.equal(code, 0, err.text());
    const written = JSON.parse(fs.readFileSync(targetConfig, "utf8")) as {
      mcpServers: { existing: { command: string }; gathergate: { command: string; args: string[]; env: { GATHERGATE_URL: string } } };
    };
    assert.equal(written.mcpServers.existing.command, "echo");
    assert.equal(written.mcpServers.gathergate.command, "npx");
    assert.deepEqual(written.mcpServers.gathergate.args, ["-y", "gathergate", "mcp"]);
    assert.equal(written.mcpServers.gathergate.env.GATHERGATE_URL, "https://intake.harbour.com.au");

    // 4. VS Code --write merges inputs[] idempotently
    const vscodePath = path.join(tmpDir, "vscode-mcp.json");
    const vscodeSetup = generateClientSetup({ client: "vscode", url: "https://intake.harbour.com.au", transport: "http" });
    writeClientConfig(vscodeSetup, vscodePath);
    writeClientConfig(vscodeSetup, vscodePath);
    const vscodeJson = JSON.parse(fs.readFileSync(vscodePath, "utf8")) as { inputs: unknown[]; servers: Record<string, unknown> };
    assert.equal(vscodeJson.inputs.length, 1);
    assert.ok("gathergate" in vscodeJson.servers);

    // 5. Corrupt existing JSON fails closed without clobbering file
    const corruptPath = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(corruptPath, "{broken-json");
    assert.throws(() => writeClientConfig(vscodeSetup, corruptPath), /not valid JSON/);
    assert.equal(fs.readFileSync(corruptPath, "utf8"), "{broken-json");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI mcp stdio bridge: real child-process modern 2026-07-28 + legacy initialize, tools, skills, errors & zero stdout pollution", async () => {
  const live = await bootLiveTcpGatherGate();
  try {
    const rwKey = await live.mintKey("Stdio Agent", ["mcp:read", "requests:write"]);

    // 1. Real child process: MCP 2026-07-28 flow (server/discover -> tools/list -> tools/call -> skills/get -> resources/read -> malformed JSON)
    const modernFrames = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_templates", arguments: {} },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "skills/get",
        params: { uri: "skill://gathergate/SKILL.md" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "skill://gathergate/SKILL.md" },
      }),
      "{not-valid-json",
    ].join("\n") + "\n";

    const modernProc = await spawnCliProcess(["mcp", "--url", live.baseUrl], {
      env: { ...process.env, GATHERGATE_API_KEY: rwKey.secret },
      stdinText: modernFrames,
    });
    assert.equal(modernProc.code, 0, `Bridge failed: ${modernProc.stderr}`);
    assert.equal(modernProc.stdout.includes(rwKey.secret), false);
    assert.equal(modernProc.stderr.includes(rwKey.secret), false);

    // Every stdout line MUST be valid JSON-RPC (zero stdout pollution)
    const modernLines = modernProc.stdout.trim().split(/\r?\n/);
    assert.equal(modernLines.length, 6);
    const modernResponses = modernLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal((modernResponses[0].result as { resultType: string }).resultType, "complete");
    assert.equal((modernResponses[1].result as { tools: unknown[] }).tools.length, 7);
    assert.equal(
      ((modernResponses[2].result as { structuredContent: { templates: unknown[] } }).structuredContent.templates.length >= 4),
      true
    );
    assert.equal(
      (modernResponses[3].result as { skill: { uri: string } }).skill.uri,
      "skill://gathergate/SKILL.md"
    );
    assert.match(
      (modernResponses[4].result as { contents: Array<{ text: string }> }).contents[0].text,
      /Hard Security Boundary/
    );
    assert.equal((modernResponses[5].error as { code: number }).code, -32700);

    // 2. Legacy MCP client flow (initialize -> notifications/initialized [no stdout] -> tools/list -> create_request with ConsoleEmailAdapter -> zero stdout pollution)
    const legacyFrames = [
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 12, method: "resources/templates/list" }),
    ].join("\n") + "\n";

    const legacyProc = await spawnCliProcess(["mcp"], {
      env: { ...process.env, GATHERGATE_URL: `${live.baseUrl}/mcp`, GATHERGATE_API_KEY: `Bearer ${rwKey.secret}` },
      stdinText: legacyFrames,
    });
    assert.equal(legacyProc.code, 0, `Legacy bridge failed: ${legacyProc.stderr}`);
    const legacyLines = legacyProc.stdout.trim().split(/\r?\n/);
    // Notification produces NO stdout line -> 3 responses for 4 frames
    assert.equal(legacyLines.length, 3);
    const legacyResponses = legacyLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal((legacyResponses[0].result as { protocolVersion: string }).protocolVersion, "2025-11-25");
    assert.equal("resultType" in (legacyResponses[1].result as Record<string, unknown>), false);
    assert.deepEqual((legacyResponses[2].result as { resourceTemplates: unknown[] }).resourceTemplates, []);

    // 3. Invalid API key returns JSON-RPC error -32001 on stdout without leaking secret
    const stdinErr = new PassThrough();
    const stdoutErr = captureStream();
    const stderrErr = captureStream();
    stdinErr.end(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n`);
    const badAuthCode = await runMcpStdioBridge({
      url: live.baseUrl,
      apiKey: "gg_live_bad_key_value",
      input: stdinErr,
      output: stdoutErr.stream,
      errorOutput: stderrErr.stream,
    });
    assert.equal(badAuthCode, 0);
    assert.equal(stdoutErr.text().includes("gg_live_bad_key_value"), false);
    assert.equal(stderrErr.text().includes("gg_live_bad_key_value"), false);
    const errFrame = JSON.parse(stdoutErr.text().trim()) as { id: number; error: { code: number } };
    assert.equal(errFrame.id, 99);
    assert.equal(errFrame.error.code, -32001);

    // 4. Missing API key fails fast with exit 1 and writes only to stderr
    const missingKey = await spawnCliProcess(["mcp", "--url", live.baseUrl], {
      env: { PATH: process.env.PATH },
    });
    assert.equal(missingKey.code, 1);
    assert.equal(missingKey.stdout, "");
    assert.match(missingKey.stderr, /GATHERGATE_API_KEY is required/);

    // 4b. Batch array JSON-RPC frame gets -32600 response on stdout (never hangs silently),
    //     and untrusted CWD .env is NEVER loaded by `gathergate mcp`
    const untrustedRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-untrusted-cwd-"));
    try {
      fs.writeFileSync(path.join(untrustedRepo, ".env"), "GATHERGATE_URL=https://evil.invalid\n");
      const batchProc = await spawnCliProcess(["mcp", "--url", live.baseUrl], {
        cwd: untrustedRepo,
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, GATHERGATE_API_KEY: rwKey.secret },
        stdinText: `${JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])}\n`,
      });
      assert.equal(batchProc.code, 0, batchProc.stderr);
      const batchResp = JSON.parse(batchProc.stdout.trim()) as { id: null; error: { code: number } };
      assert.equal(batchResp.id, null);
      assert.equal(batchResp.error.code, -32600);

      // Even without --url, untrusted CWD .env must NOT redirect default GATHERGATE_URL to evil.invalid
      const hijackCheck = await spawnCliProcess(["mcp"], {
        cwd: untrustedRepo,
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, GATHERGATE_API_KEY: "gg_live_bad\nbad" },
        stdinText: "",
      });
      assert.equal(hijackCheck.code, 1);
      assert.equal(hijackCheck.stdout, "");
      assert.equal(hijackCheck.stderr.includes("gg_live_bad"), false, "Malformed key must never be echoed");
      assert.match(hijackCheck.stderr, /invalid characters/i);
    } finally {
      fs.rmSync(untrustedRepo, { recursive: true, force: true });
    }

    // 5. Verify server.json includes both npm stdio package and streamable-http remote
    const serverManifest = JSON.parse(fs.readFileSync(path.resolve("server.json"), "utf8")) as {
      packages: Array<{ registryType: string; identifier: string; transport: { type: string }; packageArguments: Array<{ value: string }> }>;
      remotes: Array<{ type: string; headers: Array<{ name: string; value: string }> }>;
    };
    assert.equal(serverManifest.packages[0].registryType, "npm");
    assert.equal(serverManifest.packages[0].identifier, "gathergate");
    assert.equal(serverManifest.packages[0].transport.type, "stdio");
    assert.equal(serverManifest.packages[0].packageArguments[0].value, "mcp");
    assert.equal(serverManifest.remotes[0].headers[0].value, "Bearer {api_key}");
  } finally {
    live.cleanup();
  }
});

test("CLI serve: loads .env automatically, binds dynamic --port 0, serves /healthz, and shuts down cleanly", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gathergate-serve-env-"));
  const dataDir = path.join(workDir, "vault-data");
  const masterKeyHex = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(
    path.join(workDir, ".env"),
    `MASTER_KEY=${masterKeyHex}\nDATA_DIR=${dataDir.replace(/\\/g, "/")}\nCRON_INTERVAL_MINUTES=0\n`
  );

  const args = ["--import", TSX_IMPORT, path.resolve("src", "index.ts"), "serve", "--host", "127.0.0.1", "--port", "0"];

  const child = spawn(process.execPath, args, {
    cwd: workDir,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const listenUrl = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        reject(new Error(`Server did not start in time.\nstdout=${stdout}\nstderr=${stderr}`));
      }, 15_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        stdout += d;
        const m = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early (${code}).\nstdout=${stdout}\nstderr=${stderr}`));
      });
    });

    const healthRes = await fetch(`${listenUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { ok: true, service: "gathergate" });
    // Verify .env MASTER_KEY was loaded (no auto-generated .master.key created!)
    assert.equal(fs.existsSync(path.join(dataDir, ".master.key")), false);
    assert.equal(fs.existsSync(path.join(dataDir, "gathergate.sqlite")), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
