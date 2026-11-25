// Verifies README local assets/links, release version alignment, and doc hygiene before launch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(ROOT, "README.md");
const readme = fs.readFileSync(readmePath, "utf8");

// 1. Validate every relative markdown image and link in README.md.
const linkPattern = /(!?)\[[^\]]*\]\(([^)]+)\)/g;
const checkedFiles = new Set();
let imageCount = 0;

for (const match of readme.matchAll(linkPattern)) {
  const isImage = match[1] === "!";
  const rawTarget = match[2].trim().split(/\s+/)[0];
  if (/^(https?:|mailto:|#)/i.test(rawTarget)) continue;

  const cleanRel = rawTarget.split("#")[0].split("?")[0];
  const resolved = path.resolve(ROOT, cleanRel);
  assert.ok(resolved.startsWith(ROOT + path.sep), `Link escapes repo root: ${rawTarget}`);
  assert.ok(fs.existsSync(resolved), `Missing README target: ${cleanRel}`);

  const stat = fs.statSync(resolved);
  assert.ok(stat.isFile() && stat.size > 0, `README target is empty or not a file: ${cleanRel}`);
  checkedFiles.add(cleanRel);

  if (isImage) {
    imageCount += 1;
    const head = fs.readFileSync(resolved).subarray(0, 8);
    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".png") {
      assert.equal(head.subarray(0, 4).toString("hex"), "89504e47", `Invalid PNG header: ${cleanRel}`);
    } else if (ext === ".gif") {
      assert.match(head.subarray(0, 6).toString("ascii"), /^GIF8[79]a$/, `Invalid GIF header: ${cleanRel}`);
      assert.ok(stat.size < 5 * 1024 * 1024, `GIF exceeds 5 MB GitHub budget (${stat.size} bytes): ${cleanRel}`);
    }
  }
}

assert.ok(imageCount >= 3, `Expected at least 3 README images, found ${imageCount}`);

// 2. Enforce zero em-dashes across core repository docs.
for (const docName of ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"]) {
  const content = fs.readFileSync(path.join(ROOT, docName), "utf8");
  assert.ok(!content.includes("\u2014"), `Found disallowed em-dash (U+2014) in ${docName}`);
}

// 3. Verify package versions match across root, client, and site, and exist in CHANGELOG.md.
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const clientPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "client", "package.json"), "utf8"));
const sitePkg = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "package.json"), "utf8"));
assert.equal(clientPkg.version, rootPkg.version, "client/package.json version must match root");
assert.equal(sitePkg.version, rootPkg.version, "site/package.json version must match root");

const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
assert.ok(
  changelog.includes(`## [${rootPkg.version}]`),
  `CHANGELOG.md missing heading for version ${rootPkg.version}`
);

console.log(
  `PASS: README verified (${checkedFiles.size} local targets, ${imageCount} images), docs clean, v${rootPkg.version} aligned`
);
