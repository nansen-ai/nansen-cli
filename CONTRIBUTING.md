# Contributing

## Before You Open a PR

```bash
npm install
npm test
```

All tests are mocked (no API key needed). Passing output:

```
 Test Files  15 passed (15)
      Tests  678 passed | 2 skipped (680)
```

Paste the final output in your PR description so reviewers can verify.

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

## PR Checklist

- [ ] `npm test` passes (paste output in PR)
- [ ] New code paths have tests + RPC mocks cover all methods
- [ ] No `console.log` in core, no hardcoded secrets
- [ ] Error messages are actionable
- [ ] Changeset added (if user-facing)
