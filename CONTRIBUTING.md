# Contributing to GatherGate

GatherGate follows a **trunk-based workflow** on a single long-lived branch (`main`). There is no permanent `dev` branch: `main` stays green, tested, and deployable at all times.

---

## Branching & Release Model

- **Single trunk (`main`):** All changes land via short-lived branches and squash-merged pull requests.
- **Branch naming:** `feat/<short-slug>`, `fix/<short-slug>`, `security/<short-slug>`, `docs/<short-slug>`, `chore/<short-slug>`.
- **Commit messages:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat(review): ...`, `fix(portal): ...`, `security(otp): ...`, `docs: ...`).
- **Releases:** Immutable SemVer tags (`v0.1.0`, `v1.0.0`) on `main`. Tagging triggers `.github/workflows/release.yml` to publish multi-arch (`amd64`/`arm64`) container images to GHCR and generate GitHub Release notes.

---

## Feature & Bug-Fix Workflow

Follow the matching checklist whenever you add a feature or fix a bug.

### Adding a Feature
1. **Branch from `main`:** `git checkout -b feat/<short-slug>`.
2. **Keep scope tight:** Reuse existing helpers, `shadcn/ui` components, and semantic CSS tokens (`client/src/index.css`). Never hardcode hex colours outside CSS tokens or `client/src/lib/brand.ts`.
3. **Database changes (if any):** Add idempotent, append-only migrations in `src/db/client.ts` (`COLUMN_MIGRATIONS`) and update the base `CREATE TABLE` DDL so fresh and upgraded SQLite databases match. Never rename or drop columns in place.
4. **Security & tenant boundaries:** Scope every operator query and route by `auth.workspace.id`, validate untrusted inputs at trust boundaries, fail closed on unknown validators or file signatures, and record operator/client mutations in `audit_events`.
5. **Copy & style invariants:** Use `en-AU` spelling (`normalises`, `standardised`, `colours`, `artefacts`), generic TensorForge attribution (`contact@tensorforge.dev`), and zero em-dashes (`U+2014`).
6. **Tests (required):**
   - Backend route/store logic: add cases in `tests/`.
   - Client interaction/state logic: add Vitest + Testing Library tests beside the component or page.
   - End-to-end or new screen: extend `e2e/` and verify 0 serious/critical WCAG 2.2 AA violations via `expectAccessible` in Light and Dark themes.
7. **Update `CHANGELOG.md`:** Add a one-line bullet under `[Unreleased] -> Added` (or `Changed`).
8. **Run the verification gate** (below), open a PR targeting `main`, and squash-merge once CI is green.

### Fixing a Bug
1. **Branch from `main`:** `git checkout -b fix/<short-slug>`.
2. **Write a failing test first:** Reproduce the bug in `tests/` (backend), Vitest (UI), or `e2e/` (browser) so it cannot regress.
3. **Fix root cause once:** Search all callers of any shared helper you change; preserve error handling, validation, and rollback behaviour.
4. **Update `CHANGELOG.md`:** Add a one-line bullet under `[Unreleased] -> Fixed` (or `Security` for security fixes).
5. **Run the verification gate** (below) and squash-merge via PR with `fix(<scope>): ...`.

---

## Adding a Country Validator Pack

Validator packs live in `src/validators/packs/` and implement `ValidatorPack` (`src/validators/packs/types.ts`):

1. Create `src/validators/packs/<country>.ts` exporting a `ValidatorPack` with pure deterministic checksum validators (`validate(value) => { valid, normalised?, error? }`). Set `sensitive: true` on government IDs that must be masked by default.
2. Register the pack in `src/validators/index.ts`. Unknown keys automatically fail closed.
3. Expose user-facing options and hints in `VALIDATOR_OPTIONS` (`client/src/lib/api.ts`).
4. Add valid, invalid-checksum, formatting, and masking unit tests in `tests/`.

---

## Local Setup & Verification Gate

Requires **Node.js >= 22.13** (Node 24+ recommended for built-in `node:crypto.argon2Sync` and `node:sqlite`).

```bash
npm install
npm --prefix client install
```

Run the full verification gate before committing or opening a PR:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
npm audit --omit=dev
npm --prefix client audit --omit=dev
```

For hot-reloading UI development, run `npm run dev` (API on `:3080`) and `npm run dev:client` (Vite on `:5173`, proxying `/api`).

---

## Maintainer Sync Note (Private Development vs Public Launch)

- While `FAAS19/gathergate` is private, development happens inside `projects/gathergate/` of the private monorepo and syncs out via:
  ```bash
  git subtree push --prefix=projects/gathergate https://github.com/FAAS19/gathergate.git main
  ```
- Never create a nested `.git` directory inside `projects/gathergate/`.
- Before accepting external community pull requests at public launch, graduate `FAAS19/gathergate` to a standalone primary repository so contributor PRs never collide with one-way subtree pushes.
