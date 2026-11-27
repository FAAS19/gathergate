import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../security/crypto.js";

export interface BundledSkillFile {
  uri: string;
  relativePath: string;
  name: string;
  mimeType: string;
  description: string;
  content: string;
  sha256: string;
}

export interface BundledSkill {
  uri: string;
  name: string;
  description: string;
  files: BundledSkillFile[];
}

function resolveSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "skills", "gathergate");
}

function parseFrontmatter(markdown: string): { name: string; description: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let name = "gathergate";
  let description =
    "Operate a self-hosted GatherGate instance over its metadata-only MCP endpoint.";
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key === "name" && val) name = val;
      if (key === "description" && val) description = val;
    }
  }
  return { name, description };
}

const SKILL_FILE_SPECS: ReadonlyArray<{
  relativePath: string;
  uri: string;
  name: string;
  description: string;
}> = [
  {
    relativePath: "SKILL.md",
    uri: "skill://gathergate/SKILL.md",
    name: "GatherGate Operator Skill",
    description:
      "Primary workflow guide for creating client checklists, triaging overdue packs, and observing the zero-PII MCP boundary.",
  },
  {
    relativePath: "references/intake-workflows.md",
    uri: "skill://gathergate/references/intake-workflows.md",
    name: "Regional Intake Workflows",
    description:
      "Guide to AU/UK/US/EU deterministic validator packs, OTP defaults, and partial-submission handling.",
  },
  {
    relativePath: "references/security-boundary.md",
    uri: "skill://gathergate/references/security-boundary.md",
    name: "MCP Security Boundary",
    description:
      "Reference for scoped workspace API keys, metadata-only invariants, and audit logging.",
  },
];

let cachedSkill: BundledSkill | null = null;

export function getBundledGatherGateSkill(): BundledSkill {
  if (cachedSkill) return cachedSkill;
  const root = resolveSkillsDir();
  const files: BundledSkillFile[] = [];

  for (const spec of SKILL_FILE_SPECS) {
    const absPath = path.join(root, spec.relativePath);
    const content = fs.readFileSync(absPath, "utf8");
    files.push({
      uri: spec.uri,
      relativePath: spec.relativePath,
      name: spec.name,
      mimeType: "text/markdown",
      description: spec.description,
      content,
      sha256: sha256Hex(content),
    });
  }

  const rootFile = files[0];
  const meta = parseFrontmatter(rootFile.content);
  cachedSkill = {
    uri: rootFile.uri,
    name: meta.name,
    description: meta.description,
    files,
  };
  return cachedSkill;
}

export function getBundledSkillResource(uri: string): BundledSkillFile | null {
  const skill = getBundledGatherGateSkill();
  return skill.files.find((f) => f.uri === uri) ?? null;
}
