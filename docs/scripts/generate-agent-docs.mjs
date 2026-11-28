// Generates clean per-page raw Markdown (/docs/<slug>.md) and compiled /docs/llms-full.txt
// alongside the built Astro Starlight site so AI agents can read exact documentation cleanly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.resolve(HERE, "..");
const CONTENT_DIR = path.join(DOCS_ROOT, "src", "content", "docs");
const OUT_DIR = path.resolve(DOCS_ROOT, "..", "site", "dist", "docs");
const SITE_ORIGIN = (process.env.DOCS_SITE || "https://gathergate.tensorforge.dev").replace(/\/+$/, "");
const RAW_DOCS_BASE = process.env.DOCS_BASE || "/docs";
const DOCS_BASE = RAW_DOCS_BASE.endsWith("/") ? RAW_DOCS_BASE : `${RAW_DOCS_BASE}/`;
const SITE_ROOT = DOCS_BASE.replace(/docs\/$/, "") || "/";

// Keep compiled llms-full.txt in the exact reading order of the Starlight sidebar.
const ORDERED_SLUGS = [
  "index",
  "getting-started/quickstart",
  "getting-started/configuration",
  "deployment/one-click-templates",
  "deployment/reverse-proxy",
  "deployment/storage",
  "deployment/email",
  "deployment/backups-and-upgrades",
  "guides/ai-agents",
  "guides/webhooks",
  "guides/validator-packs",
  "security/architecture",
];

function walkDocs(dir, relPrefix = "") {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkDocs(abs, rel));
    } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      const slug = rel.replace(/\.(md|mdx)$/i, "");
      results.push({ slug, absPath: abs });
    }
  }
  return results;
}

function parseFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { title: "", description: "", body: normalized };
  }
  let title = "";
  let description = "";
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "title") title = val;
    if (key === "description") description = val;
  }
  return { title, description, body: match[2] };
}

function resolveCanonicalHref(rawHref, pageUrl) {
  if (/^(https?:|mailto:|#)/i.test(rawHref)) return rawHref;
  try {
    return new URL(rawHref, pageUrl).toString();
  } catch {
    return rawHref;
  }
}

function stripMdxToMarkdown(body, pageUrl) {
  const lines = body.split("\n");
  const out = [];
  let inCodeFence = false;
  let inCallout = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      out.push(line);
      continue;
    }
    if (inCodeFence) {
      out.push(line);
      continue;
    }

    // Drop MDX component imports
    if (/^\s*import\s+.*from\s+["'][^"']+["'];?\s*$/.test(line)) {
      continue;
    }

    // Convert Starlight callouts (:::note[Title] ... :::) into standard blockquotes
    const calloutOpen = line.match(/^:::(note|tip|caution|danger)(?:\[([^\]]+)\])?\s*$/);
    if (calloutOpen) {
      inCallout = true;
      const heading = calloutOpen[2] || calloutOpen[1].toUpperCase();
      out.push(`> **${heading}**`);
      continue;
    }
    if (inCallout && line.trim() === ":::") {
      inCallout = false;
      out.push("");
      continue;
    }
    if (inCallout) {
      const rewrittenCallout = line.replace(/\]\(([^)\s]+)\)/g, (_m, href) => `](${resolveCanonicalHref(href, pageUrl)})`);
      out.push(rewrittenCallout.trim() ? `> ${rewrittenCallout}` : ">");
      continue;
    }

    // Convert <Tabs> / <TabItem label="..."> blocks into clean Markdown headings
    if (/^\s*<\/?(Tabs|CardGrid)\b[^>]*>\s*$/.test(line)) {
      continue;
    }
    const tabOpen = line.match(/^\s*<TabItem\b[^>]*label=["']([^"']+)["'][^>]*>\s*$/);
    if (tabOpen) {
      out.push(`### ${tabOpen[1]}`);
      out.push("");
      continue;
    }
    if (/^\s*<\/TabItem>\s*$/.test(line)) {
      out.push("");
      continue;
    }

    // Resolve relative Markdown links outside code fences to canonical URLs
    const rewritten = line.replace(/\]\(([^)\s]+)\)/g, (_m, href) => `](${resolveCanonicalHref(href, pageUrl)})`);
    out.push(rewritten);
  }

  // Convert multiline <LinkCard ... /> elements into column-0 Markdown bullet items
  let text = out.join("\n").replace(/^[ \t]*<LinkCard\b([\s\S]*?)\/>/gm, (_m, attrs) => {
    const titleMatch = attrs.match(/\btitle=["']([^"']+)["']/);
    const descMatch = attrs.match(/\bdescription=["']([^"']+)["']/);
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/);
    const title = titleMatch ? titleMatch[1] : "Guide";
    const desc = descMatch ? `: ${descMatch[1]}` : "";
    const href = hrefMatch ? resolveCanonicalHref(hrefMatch[1], pageUrl) : `${SITE_ORIGIN}${DOCS_BASE}`;
    return `- [${title}](${href})${desc}`;
  });

  // Replace standalone HTML5 <figure> blocks containing <video> only outside fenced code blocks
  text = text
    .split(/(^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$)/gm)
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment;
      return segment.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (block) => {
        if (!/<video\b[\s\S]*?<\/video>/i.test(block)) return block;
        const watchUrl = `${SITE_ORIGIN}${SITE_ROOT}#watch`;
        const sourceMatch = block.match(/<source\b[^>]*\bsrc=["']([^"']+)["']/i);
        const trackMatch = block.match(/<track\b[^>]*\bsrc=["']([^"']+)["']/i);
        const linesOut = [`- Watch product walkthrough: ${watchUrl}`];
        if (sourceMatch) {
          linesOut.push(`- Direct MP4 (1080p, 51s): ${resolveCanonicalHref(sourceMatch[1], pageUrl)}`);
        }
        if (trackMatch) {
          linesOut.push(`- English WebVTT captions: ${resolveCanonicalHref(trackMatch[1], pageUrl)}`);
        }
        return linesOut.join("\n");
      });
    })
    .join("");

  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

if (!fs.existsSync(OUT_DIR)) {
  throw new Error(`Missing built docs output directory at ${OUT_DIR}. Run astro build first.`);
}

const discovered = walkDocs(CONTENT_DIR);
const orderIndex = new Map(ORDERED_SLUGS.map((slug, idx) => [slug, idx]));
discovered.sort((a, b) => {
  const ai = orderIndex.has(a.slug) ? orderIndex.get(a.slug) : Number.MAX_SAFE_INTEGER;
  const bi = orderIndex.has(b.slug) ? orderIndex.get(b.slug) : Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.slug.localeCompare(b.slug);
});

const renderedPages = [];
for (const doc of discovered) {
  const raw = fs.readFileSync(doc.absPath, "utf8");
  if (raw.includes("\u2014")) {
    throw new Error(`Disallowed em-dash (U+2014) found in ${doc.absPath}`);
  }
  const { title, description, body } = parseFrontmatter(raw);
  const pageUrl = doc.slug === "index" ? `${SITE_ORIGIN}${DOCS_BASE}` : `${SITE_ORIGIN}${DOCS_BASE}${doc.slug}/`;
  const mdUrl = `${SITE_ORIGIN}${DOCS_BASE}${doc.slug}.md`;
  const cleanBody = stripMdxToMarkdown(body, pageUrl);

  const markdown = [
    `# ${title || doc.slug}`,
    "",
    ...(description ? [`> ${description}`, ""] : []),
    `Canonical HTML: ${pageUrl}`,
    `Raw Markdown: ${mdUrl}`,
    "",
    cleanBody,
    "",
  ].join("\n");

  const outFile = path.join(OUT_DIR, `${doc.slug}.md`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, markdown, "utf8");

  renderedPages.push({
    slug: doc.slug,
    title: title || doc.slug,
    description,
    pageUrl,
    mdUrl,
    markdown,
  });
}

const tocLines = renderedPages.map(
  (p) => `- [${p.title}](${p.mdUrl}) (HTML: ${p.pageUrl})${p.description ? ` - ${p.description}` : ""}`
);

const fullTxt = [
  "# GatherGate Documentation (Full Agent Reference)",
  "",
  "> Self-hosted, MIT-licenced magic-link client document intake portal, deterministic validator engine, AES-256-GCM encrypted review vault, signed webhook queue, and built-in stateless MCP 2.0 server.",
  "",
  `- Quick index: ${SITE_ORIGIN}${SITE_ROOT}llms.txt`,
  `- Full documentation: ${SITE_ORIGIN}${DOCS_BASE}llms-full.txt`,
  `- Per-page Markdown: append .md to any documentation page slug (for example, ${SITE_ORIGIN}${DOCS_BASE}guides/ai-agents.md)`,
  `- Source repository: https://github.com/FAAS19/gathergate`,
  `- Contact: contact@tensorforge.dev`,
  "",
  "## Documentation Pages",
  "",
  ...tocLines,
  "",
  "---",
  "",
  ...renderedPages.flatMap((p) => [p.markdown.trim(), "", "---", ""]),
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "llms-full.txt"), fullTxt, "utf8");
console.log(
  `Generated ${renderedPages.length} raw Markdown docs and /docs/llms-full.txt (${Buffer.byteLength(fullTxt, "utf8")} bytes)`
);
