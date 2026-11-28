import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const docsSite = (process.env.DOCS_SITE || "https://gathergate.app").replace(/\/+$/, "");
const docsBase = process.env.DOCS_BASE || "/docs";
const normalizedDocsBase = docsBase.endsWith("/") ? docsBase : `${docsBase}/`;
const siteRoot = normalizedDocsBase.replace(/docs\/$/, "") || "/";

export default defineConfig({
  site: docsSite,
  base: docsBase,
  outDir: "../site/dist/docs",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "GatherGate Docs",
      description:
        "Self-hosting, security, deterministic validator packs, and integration guides for GatherGate.",
      favicon: "/favicon.svg",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: false,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/FAAS19/gathergate",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/FAAS19/gathergate/edit/main/docs/",
      },
      customCss: ["./src/styles/custom.css"],
      expressiveCode: {
        defaultProps: {
          wrap: true,
        },
      },
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "Overview", slug: "index" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
            { label: "Configuration (.env)", slug: "getting-started/configuration" },
          ],
        },
        {
          label: "Self-Hosting",
          items: [
            { label: "1-Click Deploy Templates", slug: "deployment/one-click-templates" },
            { label: "Reverse Proxy & TLS", slug: "deployment/reverse-proxy" },
            { label: "Storage (Local & S3/R2)", slug: "deployment/storage" },
            { label: "Email Delivery", slug: "deployment/email" },
            { label: "Backups & Upgrading", slug: "deployment/backups-and-upgrades" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "AI Agents & MCP 2.0", slug: "guides/ai-agents" },
            { label: "Webhooks, Retries & API Keys", slug: "guides/webhooks" },
            { label: "Validator Packs", slug: "guides/validator-packs" },
          ],
        },
        {
          label: "Security",
          items: [
            { label: "Security & Threat Model", slug: "security/architecture" },
          ],
        },
        {
          label: "Links",
          items: [
            { label: "Full Docs (llms-full.txt)", link: `${docsSite}${normalizedDocsBase}llms-full.txt` },
            { label: "Interactive Demo", link: `${docsSite}${siteRoot}demo/#/` },
            { label: "GatherGate Home", link: `${docsSite}${siteRoot}` },
          ],
        },
      ],
    }),
  ],
});
