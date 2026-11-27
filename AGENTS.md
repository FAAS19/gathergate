# GatherGate Agent Guidelines

Contributor and coding-agent rules for `FAAS19/gathergate`.

## Stack & Architecture
- **Runtime**: Node.js >= 22.13 (Node 24+ recommended), built-in `node:sqlite` (WAL) and `node:crypto`, Hono backend (`5` production dependencies), built-in CLI (`src/cli.ts`: `serve`, `doctor`, `setup`, stdio `mcp`) and stateless MCP 2.0 endpoint (`POST /mcp` + `skills/gathergate/` + `server.json`), React 19 + `shadcn/ui` + Tailwind CSS v4 (`client/`), static showcase (`site/`), and Astro Starlight docs (`docs/`).
- **Minimal core**: Keep core focused on self-hosted magic-link intake, deterministic validation, AES-256-GCM storage, signed webhook retries, metadata-only MCP, and operator triage. Country/domain checksums belong in `src/validators/packs/`. Never add unrequested dependencies, telemetry, or external SaaS calls.

## Non-Negotiable Invariants
- **Tenant & route isolation**: Scope every operator DB query and API route by `auth.workspace.id`. Validate untrusted inputs at trust boundaries, fail closed on unknown validator keys or file magic-bytes, and record mutations in `audit_events`.
- **SQLite migrations**: Keep migrations append-only and idempotent in `src/db/client.ts` (`MIGRATIONS` + matching base `CREATE TABLE` DDL). Never rename or drop columns in place.
- **UI & styling**: Reuse `shadcn/ui` primitives and CSS variables in `client/src/index.css`. Never hardcode hex colours outside CSS tokens or `client/src/lib/brand.ts`. Keep Light and Dark WCAG 2.2 AA compliance.
- **Copy & attribution**: Use Australian English (`en-AU`: `standardised`, `normalises`, `colours`, `artefacts`), generic TensorForge attribution (`contact@tensorforge.dev`), zero em-dashes (`U+2014`), and zero emojis in code, commits, or PRs.
- **PR hygiene**:
  - Do not edit `CHANGELOG.md` in contributor PRs (maintainers curate it at release time).
  - Avoid unintended edits to `package-lock.json`, `client/package-lock.json`, `site/package-lock.json`, or `docs/package-lock.json` unless intentionally updating dependencies.
  - Keep diffs focused on one issue.

## Verification Gate (Run Before Opening a PR)
```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
node e2e/verify-readme.mjs
```

When modifying `site/` or `docs/`, also run `npm run test:pages`.
