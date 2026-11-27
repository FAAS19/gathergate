## Summary
<!-- Briefly describe what changed and why. Link the related issue if applicable (e.g. Closes #12). -->

## Type of Change
- [ ] Feature (`feat:`)
- [ ] Bug fix (`fix:`)
- [ ] Security fix (`security:`)
- [ ] Documentation / chore (`docs:` / `chore:`)

## AI Assistance
<!-- State "None", or name the tool used and briefly confirm how you reviewed and verified the output. -->

## Checklist
- [ ] Branch targets `main` with a focused diff (no unrelated edits).
- [ ] I have read, tested, and understand every line in this diff.
- [ ] Added or updated tests (regression test first for bug fixes).
- [ ] Left `CHANGELOG.md` untouched (maintainers update it at release) and avoided unintended lockfile changes.
- [ ] Checked tenant isolation (`workspace_id`), input validation, and audit logging on touched routes.
- [ ] Verified `en-AU` copy, zero em-dashes (`U+2014`), and zero hardcoded hex colours in UI components.
- [ ] Local verification gate passed:
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
  - `npm run test:e2e`
