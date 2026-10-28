# Authentication

The Nansen API accepts three ways to authenticate and pay for calls: a Nansen account, x402 and MPP via tempo. The [README](../README.md#auth) shows one command for each. This page has the details.

## Nansen account: browser login or API key

Plain `nansen login` requests fresh browser approval and saves a session automatically. No API-key copying or PEM setup is needed. Selected sessions renew automatically; rejected or uncertain renewal requires fresh login.

```bash
nansen login                 # approve the displayed code, account and CLI
nansen login --no-browser    # approve on another device; same storage requirements
nansen auth status           # offline, cached/unverified credential selection
nansen account               # free live check, including with zero research credits
nansen logout                # clear saved API auth; preserve wallets and environment keys
```

Browser login is available in Nansen CLI 2.0.0 and enabled in production. Saved browser sessions are currently qualified on macOS arm64 in a local GUI Terminal with an unlocked login Keychain and local home directory. Other platforms and terminal environments still need qualification. See [storage, supported scope and recovery](browser-login.md). Email/password and Google sign-in are supported by the device-flow contract. Apple device sign-in remains deferred.

Existing API-key users can run commands directly with `NANSEN_API_KEY`. It overrides the saved session, even after successful browser login. To deliberately save an injected key, use explicit `nansen login --human`; without an environment key this prompts in a human terminal. `nansen login --api-key <key>` remains available but puts the key in shell history. Saved-auth mutations require the native lock binding. Get a conventional key at [agent setup](https://app.nansen.ai/auth/agent-setup); MCP installation exports a separate persistent API key; it does not export browser sessions.

On a server, in a container, or in CI without a credential store, get your key from [the API page](https://app.nansen.ai/api) and use it directly:

```bash
export NANSEN_API_KEY='<your-api-key>'
nansen account
```

No `nansen login` is needed. Core API commands using the environment key require neither secure storage nor native authentication locking. The variable stays set for this terminal session; for automation, inject it through your platform's secret manager. See [headless setup, including PowerShell](browser-login.md#servers-containers-and-ci-without-secure-storage).

To save a key for later commands on a machine with native authentication locking, pipe it from your secret manager into `nansen login --api-key-stdin`, or redirect a protected key file:

```bash
nansen login --api-key-stdin --json < /path/to/protected-api-key
```

This reads one key (up to 4096 bytes, with an optional trailing newline), verifies it, and saves it without printing it. Input must close within 30 seconds. `--json` prints one `saved` event with the effective credential source; errors exit nonzero. As with existing API-key login, the key is stored in `~/.nansen/config.json` using an atomic write with owner-only file permissions (`0600` on POSIX), not in the OS keychain. The native lock binding is required for saving credentials. It does not create an account or issue a key. Avoid commands containing literal secrets, which may enter shell history. Do not combine it with `--api-key`, `--human`, or `--no-browser`. An existing `NANSEN_API_KEY` still overrides the saved credential until you unset it.

### Browser login compatibility and scope

Browser login requests `nansen:api` for the same account/API permissions as a pasted API key, including smart-alert CRUD, public agent, portfolio, web, beta and existing trading API operations. The same endpoint ownership, plan, credit, quota, sanctions and geographic checks apply. Existing OAuth/MCP `nansen:read` grants keep their existing semantics. Wallet signing remains separate.

Plain `nansen login` always starts fresh browser approval, whether no credential, an environment key, a saved key or a saved session exists. It preflights secure storage, shows a link/code, verifies the approved account through the free account endpoint, then replaces the single saved API credential. `nansen login --no-browser` lets you approve on another device without opening a browser on the CLI machine. It does not remove the native-storage or supported-platform requirements. Browser login requires both stdin and stdout to be terminals; without either, it exits immediately with `NOT_A_TTY` and explains how to use `NANSEN_API_KEY` directly without login. Deliberately saving a key with `--human` or `--api-key-stdin` still requires native locking. In a terminal, `--json` emits NDJSON pending and terminal events; the private device code and tokens are never printed.

`NANSEN_API_KEY` still overrides the saved session. Login verifies the new account independently and explains this override. Failed approval or installation preserves the previous selection. `nansen auth status` is offline and labels saved metadata as cached/unverified; `nansen account` checks the effective credential live. `nansen logout` removes saved API authentication and attempts family retirement, preserving wallets and environment keys. Remote revocation and physical deletion failures are reported separately.

This is a breaking change for scripts that used plain login to persist an environment key. Use explicit `nansen login --human` with that environment key, or `--api-key <key>` with its existing shell-history risk. Direct key-authenticated commands need no migration. Existing API-key x402 payment behavior is preserved and also applies to browser sessions: a supported HTTP 402 challenge can trigger wallet payment under the existing policy and spending limits. A paid retry does not change the saved credential or top up account credits. Invalid credentials never cause an account switch or payment; login verification remains free and never pays.

Browser login is enabled in production. Saved browser-session storage is [qualified on macOS arm64](browser-login.md#preview-platform-scope); Linux qualification is pending, and Windows and SSH/background sessions are not qualified. Selected sessions renew automatically near expiry. If a refresh response is lost before a complete replacement is stored, follow the fresh-login guidance; the CLI never retries a consumed refresh credential. Browser sessions have the same account API permissions as API keys, subject to existing endpoint checks. They add no wallet-signing or internal-service authority and cannot be exported as MCP API keys. See [storage and recovery](browser-login.md).

## x402

Create and fund a wallet with USDC on Base/Solana or USDT0 on X Layer. API keys, browser sessions and anonymous requests can all pay a supported HTTP 402 challenge under the same wallet policy and spending limits. The paid retry sends `Payment-Signature` without the account credential. Authentication or authorization failures never trigger payment. Explicit manual API-key payment signatures remain supported.

## MPP via tempo

Install the separate tempo CLI and use `tempo request`. Browser login does not configure a wallet, sign MPP credentials or purchase credits. See [MPP / Tempo](../README.md#mpp--tempo).
