## Summary
<!-- Briefly describe what changed and why. -->

## Type of Change
- [ ] Feature (`feat:`)
- [ ] Bug fix (`fix:`)
- [ ] Security fix (`security:`)
- [ ] Documentation / chore (`docs:` / `chore:`)

## Checklist
- [ ] Branch targets `main` with a focused diff (no unrelated edits).
- [ ] Added or updated tests (regression test first for bug fixes).
- [ ] Updated `CHANGELOG.md` under `[Unreleased]`.
- [ ] Checked tenant isolation (`workspace_id`), input validation, and audit logging on touched routes.
- [ ] Verified `en-AU` copy, zero em-dashes (`U+2014`), and zero hardcoded hex colours in UI components.
- [ ] Local verification gate passed:
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
  - `npm run test:e2e`
