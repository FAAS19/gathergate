import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const docsBase = process.env.DOCS_BASE || "/docs";

export default defineConfig({
  site: "https://gathergate.tensorforge.dev",
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
            { label: "Reverse Proxy & TLS", slug: "deployment/reverse-proxy" },
            { label: "Storage (Local & S3/R2)", slug: "deployment/storage" },
            { label: "Email Delivery", slug: "deployment/email" },
            { label: "Backups & Upgrading", slug: "deployment/backups-and-upgrades" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "Signed Webhooks & n8n", slug: "guides/webhooks" },
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
            { label: "Interactive Demo", link: "/demo/#/" },
            { label: "GatherGate Home", link: "/" },
          ],
        },
      ],
    }),
  ],
});
