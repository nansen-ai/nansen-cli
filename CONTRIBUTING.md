# Contributing

## Before You Open a PR

```bash
npm install
npm test
npm run lint
```

All tests are mocked (no API key needed). All test files should pass with 0 failures (a small number of skipped tests is expected).

Paste the final `npm test` output in your PR description so reviewers can verify.

## Changesets

If your change affects users (new feature, bug fix, changed output), add a changeset file. `npm test` warns if one is missing.

Create `.changeset/<descriptive-name>.md`:

```markdown
---
"nansen-cli": patch
---

Short description (appears in CHANGELOG)
```

`patch` = bug fix, `minor` = new feature, `major` = breaking change.

Skip for docs-only, test-only, or refactors with no behavior change.

Changesets are temporary — CI consumes them and auto-updates CHANGELOG.md when releasing.

## Linting

ESLint enforces code quality. Auto-fix most issues with:

```bash
npm run lint:fix
```

Prefix intentionally unused variables with `_` (e.g. `_err`, `_args`).

## PR Checklist

- [ ] `npm test` passes (paste output in PR)
- [ ] `npm run lint` passes
- [ ] New code paths have tests + RPC mocks cover all methods
- [ ] No `console.log` in core, no hardcoded secrets
- [ ] Error messages are actionable
- [ ] Changeset added (if user-facing)
- [ ] `src/schema.json` updated if new commands or options were added (file is maintained manually — no codegen)
