// Verifies README local assets/links (Markdown + HTML), release version alignment, and doc hygiene.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(ROOT, "README.md");
const readme = fs.readFileSync(readmePath, "utf8");

const checkedFiles = new Set();
let imageCount = 0;

function validateTarget(rawTarget, isImage) {
  const target = rawTarget.trim().split(/\s+/)[0];
  if (!target || /^(https?:|mailto:|#)/i.test(target)) return;

  const cleanRel = target.split("#")[0].split("?")[0];
  const resolved = path.resolve(ROOT, cleanRel);
  assert.ok(resolved.startsWith(ROOT + path.sep), `Link escapes repo root: ${target}`);
  assert.ok(fs.existsSync(resolved), `Missing README target: ${cleanRel}`);

  const stat = fs.statSync(resolved);
  assert.ok(stat.isFile() && stat.size > 0, `README target is empty or not a file: ${cleanRel}`);
  checkedFiles.add(cleanRel);

  if (isImage) {
    imageCount += 1;
    const buf = fs.readFileSync(resolved);
    const head = buf.subarray(0, 12);
    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".png") {
      assert.equal(head.subarray(0, 4).toString("hex"), "89504e47", `Invalid PNG header: ${cleanRel}`);
    } else if (ext === ".gif") {
      assert.match(head.subarray(0, 6).toString("ascii"), /^GIF8[79]a$/, `Invalid GIF header: ${cleanRel}`);
      assert.ok(stat.size < 5 * 1024 * 1024, `GIF exceeds 5 MB GitHub budget (${stat.size} bytes): ${cleanRel}`);
    } else if (ext === ".webp") {
      assert.equal(head.subarray(0, 4).toString("ascii"), "RIFF", `Invalid WebP RIFF header: ${cleanRel}`);
      assert.equal(head.subarray(8, 12).toString("ascii"), "WEBP", `Invalid WebP signature: ${cleanRel}`);
      assert.ok(stat.size < 5 * 1024 * 1024, `WebP exceeds 5 MB GitHub budget (${stat.size} bytes): ${cleanRel}`);
    } else if (ext === ".svg") {
      assert.match(buf.toString("utf8", 0, 512), /<svg[\s>]/i, `Invalid SVG root tag: ${cleanRel}`);
    }
  }
}

// 1. Validate every relative Markdown image/link and HTML <img>/<source>/<a> target in README.md.
const linkPattern = /(!?)\[[^\]]*\]\(([^)]+)\)/g;
for (const match of readme.matchAll(linkPattern)) {
  validateTarget(match[2], match[1] === "!");
}

const htmlSrcPattern = /<(img|source)\b[^>]*\b(?:src|srcset)=["']([^"']+)["']/gi;
for (const match of readme.matchAll(htmlSrcPattern)) {
  const candidates = match[2].split(",").map((s) => s.trim().split(/\s+/)[0]);
  for (const candidate of candidates) {
    validateTarget(candidate, true);
  }
}

const htmlHrefPattern = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
for (const match of readme.matchAll(htmlHrefPattern)) {
  validateTarget(match[1], false);
}

assert.ok(imageCount >= 3, `Expected at least 3 README images, found ${imageCount}`);

// 2. Enforce zero em-dashes across core repository docs, agent guides, and bundled skills.
function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(abs));
    } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      files.push(abs);
    }
  }
  return files;
}

const docFilesToCheck = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "AGENTS.md",
  "site/public/llms.txt",
  ...listMarkdownFiles(path.join(ROOT, "skills", "gathergate")).map((abs) => path.relative(ROOT, abs)),
  ...listMarkdownFiles(path.join(ROOT, "docs", "src", "content", "docs")).map((abs) => path.relative(ROOT, abs)),
];
for (const relPath of docFilesToCheck) {
  const content = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  assert.ok(!content.includes("\u2014"), `Found disallowed em-dash (U+2014) in ${relPath}`);
}

// 3. Verify release versions stay aligned across packages, MCP manifest, Umbrel app, README badge, and CHANGELOG.
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const clientPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "client", "package.json"), "utf8"));
const sitePkg = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "package.json"), "utf8"));
const docsPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "package.json"), "utf8"));
assert.equal(clientPkg.version, rootPkg.version, "client/package.json version must match root");
assert.equal(sitePkg.version, rootPkg.version, "site/package.json version must match root");
assert.equal(docsPkg.version, rootPkg.version, "docs/package.json version must match root");

const serverManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "server.json"), "utf8"));
assert.equal(serverManifest.version, rootPkg.version, "server.json version must match root");
for (const pkgEntry of serverManifest.packages ?? []) {
  assert.equal(pkgEntry.version, rootPkg.version, "server.json packages[].version must match root");
}

const umbrelApp = fs.readFileSync(path.join(ROOT, "deploy", "umbrel", "umbrel-app.yml"), "utf8");
const umbrelVerMatch = umbrelApp.match(/^version:\s*["']?([^"'\r\n]+)["']?/m);
assert.ok(umbrelVerMatch, "deploy/umbrel/umbrel-app.yml missing version field");
assert.equal(
  umbrelVerMatch[1].trim(),
  rootPkg.version,
  "deploy/umbrel/umbrel-app.yml version must match root"
);

assert.ok(
  readme.includes(`release-v${rootPkg.version}-`),
  `README.md release badge missing version v${rootPkg.version}`
);

const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
assert.ok(
  changelog.includes(`## [${rootPkg.version}]`),
  `CHANGELOG.md missing heading for version ${rootPkg.version}`
);

console.log(
  `PASS: README verified (${checkedFiles.size} local targets, ${imageCount} images), docs clean, v${rootPkg.version} aligned`
);
