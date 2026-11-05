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

## Signed Commits

Every commit merged into `main` must have a verified signature. A PR with unsigned commits cannot be merged, so set up signing before you push.

1. Add an SSH or GPG key to your GitHub account as a signing key (an SSH key added only for authentication does not count) and configure git to use it. See GitHub's [About commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification). For an SSH key:

   ```bash
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   git config --global commit.gpgsign true
   ```

2. Use an email on your commits that is verified on your GitHub account (your GitHub `noreply` address works). GitHub shows a signed commit as "Verified" only when the email matches.

If you already pushed unsigned commits, re-sign them and force-push your branch. Here `upstream` is the `nansen-ai/nansen-cli` remote; in a clone of the main repo rather than a fork, use `origin/main`:

```bash
git fetch upstream
git rebase --exec 'git commit --amend --no-edit -S' upstream/main
git push --force-with-lease
```

Check the commits tab of your PR: each commit should show "Verified".

## PR Checklist

- [ ] All commits are signed and show "Verified" on GitHub
- [ ] `npm test` passes (paste output in PR)
- [ ] `npm run lint` passes
- [ ] New code paths have tests + RPC mocks cover all methods
- [ ] No `console.log` in core, no hardcoded secrets
- [ ] Error messages are actionable
- [ ] Changeset added (if user-facing)
- [ ] `src/schema.json` updated if new commands or options were added (file is maintained manually — no codegen)
