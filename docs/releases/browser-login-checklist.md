# Browser login release checklist

This checklist is for maintainers. It does not announce a release or approve production access. Store account-specific test evidence, deployment inventories and incident details in access-controlled project records.

## Before release

- Name the supported OS, architecture and terminal environments. Test the packaged artifact on each advertised platform with its real native credential store.
- Verify browser approval, credential precedence, failed-login preservation, storage recovery, automatic and concurrent renewal, restart, logout and server-side revocation.
- Verify account validation and billing using controlled accounts. Record exceptions explicitly; a waived check is not a passing check.
- Confirm revocation rejects retained copies of original and refreshed access tokens while unrelated sessions remain valid. Test outage and retention behavior before relying on those guarantees.
- Keep user-facing help, schema, README, packaged recovery guidance and skills consistent. Do not infer published support from an OS adapter or test fixture.
- Choose the version, channel, release owner and rollback plan. Identify each tested archive by source commit and integrity digest; matching version strings do not establish matching bytes.

## Distribution controls

The current workflows require repository variable `CLI_PUBLICATION_ENABLED` to equal `true` for publication and ClawHub sync. Missing or false keeps those jobs disabled. This gate does not control server-side browser access.

Before relying on the gate, check for older ungated workflow runs and manual publication paths. Enable publication only for an approved release window. A code-review approval is not permission to publish or activate production.

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
