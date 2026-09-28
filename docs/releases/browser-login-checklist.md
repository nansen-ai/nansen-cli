# Browser login release checklist

This checklist is for maintainers. It does not announce a release or approve production access. Store account-specific test evidence, deployment inventories and incident details in access-controlled project records.

CLI 2.0.0 was published and production browser access enabled on September 28, 2026. The [preview platform scope](../browser-login.md#preview-platform-scope) remains limited. Use this checklist for subsequent releases; retain waived or deferred checks in private release records.

## Before release

- Name the supported OS, architecture and terminal environments. Test the packaged artifact on each advertised platform with its real native credential store.
- Verify browser approval, credential precedence, failed-login preservation, storage recovery, automatic and concurrent renewal, restart, logout and server-side revocation.
- Verify account validation and billing using controlled accounts. Record exceptions explicitly; a waived check is not a passing check.
- Confirm revocation rejects retained copies of original and refreshed access tokens while unrelated sessions remain valid. Test outage and retention behavior before relying on those guarantees.
- Keep user-facing help, schema, README, packaged recovery guidance and skills consistent. Do not infer published support from an OS adapter or test fixture.
- Choose the version, channel, release owner and rollback plan. Identify each tested archive by source commit and integrity digest; matching version strings do not establish matching bytes.

## Distribution controls

After lint and tests pass on a push to `main`, Changesets updates the release PR when pending changesets exist. Once the release PR is merged and there are no pending changesets, it publishes any unpublished package version to npm and creates a GitHub release. Keep the release PR unmerged until validation is complete.

ClawHub sync runs after a successful npm publication and can also be started manually. Manual sync distributes the selected revision's skills independently of the release PR; run it only when those skills are ready for distribution. Server-side browser access is controlled separately.

## Recovery and rollback

Prepare a tested, integrity-pinned recovery package that understands the current authentication metadata and recovery journals. Confirm its native dependencies work on the supported platforms. Record the distribution state and rehearse interrupted renewal, local cleanup and remote retirement before release.

Do not downgrade v2 metadata, delete journals or restore superseded credentials to make an older binary work. Stop concurrent auth writers before recovery. Keep revocation records and enforcement available while containing an incident; disabling new access is not equivalent to retiring existing sessions.

Use [browser login recovery guidance](../browser-login.md#offline-recovery-without-native-locking) within its stated limits. Keep environment-specific operational commands, account data and access details in the private operator runbook.

## Public documentation checks

Before committing validation material or publishing a package:

- Exclude credentials, account identifiers, balances, personal paths, private deployment addresses and raw incident captures.
- Keep internal ticket/review histories in the project tracker. Public CLI issue or PR links may be useful; they are not credentials.
- Review the actual `npm pack --dry-run --ignore-scripts` file list. A file excluded from npm is still public if committed to this repository.
- If a credential was exposed, revoke or rotate it. A deletion commit does not remove the old content from Git history or existing copies.
