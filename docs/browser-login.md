# Browser login

Browser login saves a session after you approve the CLI in your browser. This source includes browser login, but normal-release acceptance is still pending. No published browser-login cohort is established by these docs. Existing direct API-key commands remain available.

## Preview platform scope

The proposed initial preview is limited to macOS arm64, a local Terminal in a GUI login session, an unlocked login Keychain and a local home directory. It remains subject to release approval. Background agents, SSH sessions and network or synchronized home directories are not qualified by a successful local Terminal login.

Linux live remote-login qualification is pending. Windows is excluded from the initial preview. The presence of an OS adapter or native prebuilt package does not establish support. Desktop prompt cancellation and OS login/reboot persistence remain unverified.

Browser login requires enabled server access and working native credential storage. If the store is locked, unlock it and retry from the supported Terminal context. Repeating browser approval does not repair Keychain access. Missing native dependencies require reinstalling with optional dependencies enabled. There is no plaintext session-storage fallback.

## Commands and selection

```bash
nansen login
nansen login --no-browser
nansen auth status
nansen account
nansen logout
```

Plain `nansen login` always requests fresh browser approval, even when you already have a saved session or API key. Check the displayed code, account, client and requested access before approving. Visiting the link alone grants nothing. Email/password and Google are the documented sign-in methods; Apple device sign-in is not supported by this flow.

`--no-browser` runs the same flow without opening a browser automatically. You can approve on another device; the terminal needs no inbound callback and still needs usable native storage.

Ordinary commands prefer an existing supported explicit credential override, then `NANSEN_API_KEY`, then the active saved credential. Plain login does not copy an environment key into config. The candidate browser session is checked independently before it replaces a saved credential. An environment key still takes precedence afterward; unset it to use the saved session.

Explicit legacy key setup remains available through `nansen login --human` and `nansen login --api-key <key>`. Prefer the hidden prompt over placing secrets in shell arguments. Legacy setup retains option, environment, then hidden-prompt precedence. No new global key option or named profile is introduced.

| Starting state | Plain login | Ordinary commands after success |
| --- | --- | --- |
| No credentials | Fresh approval installs B | B |
| Environment key A only | Verify B independently, save B, report override | A until the key is unset, then B |
| Saved key A | Fresh approval replaces A after durable install | B; failed approval/install preserves A |
| Saved session A | Fresh approval installs B and retires A | B; failed approval/install preserves A |
| Environment A and saved B | Fresh approval is independent of A | A still wins; status distinguishes saved and effective |
| Missing/locked store | Fail before approval with recovery guidance | Existing direct API-key access remains usable |

Login verifies the approved account without charging for research. Research uses the effective account's credits, plan and endpoint permissions. Login does not purchase credits or create a subscription. Existing server-side account billing settings remain separate.

An invalid selected credential fails with an error. The CLI does not silently switch accounts, restore an older saved key or start automatic payment. Selected browser sessions cannot be combined with an API key or payment signature. Existing anonymous payment and explicit manual payment behavior remain separate.

## Permissions and credential safety

Browser login requests `nansen:api` for the account's API permissions. Ownership, plan, credit, quota and endpoint restrictions still apply. Wallet signing and trade confirmation remain separately authorized. Existing OAuth/MCP read-only grants are unchanged; older read-only sessions require fresh approval for API access.

API resource requests use Bearer authentication. Anyone holding a copied access token can use it until the server rejects it or it expires. Device-key proof applies to pairing, refresh and revocation; it is not required on each API resource request. Treat access tokens, refresh tokens and device keys as secrets.

Only matching trusted Nansen API origins receive session credentials. Arbitrary RPCs and separate wallet/trading authorization flows do not receive the browser token. MCP installation provisions a separate integration key and cannot export a browser session as an API key.

## Machine output

`login --json` and non-TTY login emit NDJSON. There is one pending event and one terminal event on a normal approval attempt. Preflight failure emits only the terminal error. Human progress goes to stderr in machine mode.

```json
{"version":1,"event":"pending","verification_uri":"https://idp.nansen.ai/device?user_code=ABCD-EFGH","user_code":"ABCD-EFGH","expires_at":"2026-09-19T00:10:00.000Z"}
{"version":1,"event":"saved","account_id":"example-account","effective_source":"session","cleanup":[]}
```

Failure/cancellation events contain a fixed code, message and cleanup outcomes. Events never contain device_code, access/refresh token, private JWK, proof or nonce. Public user codes are displayed only for approval, never telemetry. Local diagnostics are cached/unverified; the native store is not opened by status because it could prompt. `storage_access:not_checked_no_prompt` is deliberate, not a success claim.

## Secure storage and compatibility

Browser access tokens, refresh tokens and the private device key are stored in the OS credential store. Config and recovery journals retain bounded metadata and credential references. Legacy saved API keys retain their existing config-file storage policy. Do not share config, journals or store contents in public bug reports.

The CLI coordinates reads and writes across processes with native locking. Only local filesystems are intended. A login approved earlier cannot overwrite a later completed login or logout. Failed approval or storage leaves the previous selected credential intact.

Native lock and keyring bindings are optional package dependencies, but are required for saved-auth writes and browser-session storage. Help, offline diagnostics and direct environment/API-key requests do not open the browser-session store. macOS uses Keychain, Linux uses persistent Secret Service, and the Windows adapter uses Credential Manager. These implementations do not widen the preview platform scope above. Windows persistence may roam according to OS policy; device-local-only storage is not promised.

The session format uses chunked secure entries and a manifest. Incomplete, mixed or corrupt entries are rejected. Larger-than-supported sessions fail without replacing the previous credential. Do not manually modify these entries.

Renewal upgrades authentication metadata to v2. Logout retains v2 metadata, so installing an older pre-v2 CLI after logout is not a supported in-place downgrade. Use a tested compatible recovery version. Never force a metadata version, delete journals or restore a superseded key to make an older binary run. Do not run older and newer auth writers concurrently.

## Automatic session renewal

Ordinary commands renew the selected session near access-token expiry or after expiry. They do not open the browser. Explicit/environment keys bypass inactive saved sessions. Concurrent commands coordinate renewal through the same authentication owner.

A known non-consuming refusal can be retried with backoff. Repeated refusals eventually require fresh login. During a long cooldown, `nansen login` requests new approval. Unexpired access may still be used during a cooldown; expired access is never used.

A lost or malformed refresh response can mean the server consumed the refresh token. The CLI does not replay an uncertain token. If a complete replacement was saved, retrying the command can recover it; otherwise follow the error's fresh-login guidance. Storage-access errors require repairing storage first. Correct system time when the error indicates clock skew. API authentication failure never triggers account switching or payment fallback.

`nansen auth status` reports cached, unverified metadata without opening the store or renewing a session. Its renewal state does not prove that the server currently accepts the token. `nansen account` is the live check for the effective credential.

If an approval expires or was consumed before token issuance completed, run `nansen login` again and approve the new code. The CLI cannot assume that a failed or lost response issued no credentials.

## Logout and uncertainty

`nansen logout` clears saved API authentication and attempts to retire its browser session. It preserves wallets, wallet passwords, environment variables and independently managed API keys. It does not sign out unrelated sessions.

Local removal, a server retirement receipt and observed API rejection are separate outcomes. Revocation can take time to reach API caches. A receipt marked recorded/pending is not an immediate-rejection guarantee. Legacy refresh-only retirement can leave access tokens usable until expiry; the CLI reports that limitation. No fixed propagation time is promised here.

A locked store can allow deselection while preventing physical deletion. Unlock it and rerun logout. If remote retirement is unconfirmed, treat the remote session as potentially usable and contact support through a private channel. A missing local credential is not proof of remote revocation.

## Offline recovery without native locking

Restore the native optional dependencies before modifying saved authentication. Environment/API-key requests, help and offline diagnostics remain usable without opening the browser-session store. Do not use an incompatible older CLI as a recovery shortcut. Platforms without a verified working native binding are outside the browser-login preview.

For emergency removal of a **legacy saved API key only**, first stop every CLI/auth process, including older CLI versions. If any pending, corrupt or unrecognized auth-operations journal exists, stop and use a compatible recovery binary or support-assisted reconciliation instead. Back up config.json securely without displaying its contents. In `~/.nansen/config.json`, remove only `apiKey` and replace `auth` with `{"version":1,"selectionEpoch":"<fresh UUID>","active":{"kind":"none"}}`. If the existing auth version is 2, retain version 2 in this legacy-key-only tombstone; do not downgrade it. Generate the UUID with `node -e 'console.log(require("node:crypto").randomUUID())'`; it is not a secret. Preserve every other config field, file permissions and all wallet files. Do not modify a config whose `auth.active.kind` is `session`: restore native locking instead so its generation remains available for retirement. Do not delete `auth-operations`, lock files or OS credential entries. This offline edit removes saved-key selection only; it does not revoke an API key or remove an environment override. Once native support is restored, rerun `nansen logout` to drain pending cleanup. The packaged copy of this document is available under `docs/browser-login.md` in the installed package.

## Damaged or unrecognized journals

`AUTH_JOURNAL_INVALID` means recovery metadata could not be read safely. `AUTH_STATE_INVALID` can indicate disagreement between the selected credential and its journal. Logout may already have cleared selection while leaving cleanup incomplete. These errors do not prove the secure entries were removed or the remote session was revoked.

Do not delete, rename or quarantine journals to make login succeed. Stop all CLI/auth processes and preserve the config, journals and secure-store entries. Restore a known-valid backup only for the same operation and current state, preserving ownership and permissions. Otherwise contact support privately to reconcile the metadata. Never post credential-bearing files or store contents publicly.

After validated recovery, rerun logout and inspect its cleanup result. Cleanup is bounded per invocation; locked storage may require another attempt after unlocking. Damaged metadata requires reconciliation, not repeated unlocks or fresh approvals.

## Telemetry preferences

Set `DO_NOT_TRACK=1` or `NANSEN_NO_TELEMETRY=1` to disable telemetry. Login/logout telemetry uses fixed command paths and bounded outcome/error categories. It excludes tokens, device/user codes, private keys, flag values and raw hostnames. Local status and offline doctor remain offline; cached metadata is not proof of validity or unlocked storage.

## Release status

Browser-login publication and production access require separate release approval. The proposed platform scope above is not a normal-release support claim. Current source code or a passing test does not establish that browser login is enabled for your account. Use the documented API-key setup if browser access is unavailable.

Maintainers should use the [release checklist](https://github.com/nansen-ai/nansen-cli/blob/main/docs/releases/browser-login-checklist.md) in the repository. Internal validation captures, deployment inventories and incident records belong in access-controlled project records, not the public package.
