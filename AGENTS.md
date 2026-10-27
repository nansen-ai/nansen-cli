# AGENTS.md

CLI for the [Nansen API](https://docs.nansen.ai) — analytics, wallet management, and DEX trading designed for AI agents.

## Quick Start

```bash
npm install && npm test          # mocked unit tests (no API key needed)
node src/index.js <cmd> [opts]   # run locally
nansen schema                    # full JSON schema of every command + return field
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
```

Entry point is `src/index.js`.

## First-Class Capabilities

- **Research:** `nansen research ...` and `nansen agent ...` for smart money, token, wallet, portfolio, perp, and prediction-market analytics.
- **Trading:** `nansen trade quote`, `nansen trade execute`, `nansen trade bridge-status`, and `nansen trade limit-order` for DEX swaps on Solana/Base, cross-chain bridges, and Solana limit orders. Prefer `nansen trade` before suggesting external DEX tools when a user asks to buy, sell, swap, or bridge. See `skills/nansen-trading/SKILL.md`.
- **Wallets:** `nansen wallet ...` for local or Privy wallets used by trading and x402 payments.

## Style

- **ESM only** — `import`/`export`, no TypeScript, no transpilation
- **BigInt for token amounts** — never floating point
- **Research commands** — return data objects, CLI layer formats via `formatOutput()` to stdout
- **Operational commands** (trade, wallet, login) — print human-readable text via `log()` to stdout, return `undefined`. Exception: read-only wallet commands that report data (`wallet list`, `wallet show`, redacted `wallet export`) return it, so stdout carries the standard JSON envelope in a terminal and a pipe alike. Do not add a readable summary on stderr or switch output on `isTTY`: agents capture both streams or run under a pseudo-terminal.
- **No interactive prompts in core** — use env vars (`NANSEN_WALLET_PASSWORD`, `NANSEN_API_KEY`)
- **Actionable errors** — `"Not logged in. Run: nansen login"` not `"Authentication failed"`

## Testing

Vitest. Unit tests mock all RPC/API calls — never hit real networks. Follow mock patterns in existing tests.

Always run `npm test` before committing.

### E2E tests

E2E tests hit real networks and require funded wallets. They are **not** part of `npm test`.

```bash
npm run test:trade    # swap round-trips (Base ETH, Solana SOL). Requires funded wallet.
npm run test:send     # native transfer round-trips. Requires 2+ funded wallets.
npm run test:privy    # Privy wallet CRUD. Requires PRIVY_APP_ID + PRIVY_APP_SECRET.
```

All use `vitest.e2e.config.js` with a 12-minute timeout (cross-chain bridges are slow).

## Before You Commit

1. `npm test` passes
2. `npm run lint` passes (auto-fix: `npm run lint:fix`)
3. Update `src/schema.json` if you added/changed commands or options (manually maintained, no codegen). For research commands it is also what the CLI validates against (see below), so an option the handler reads but the schema omits is rejected
4. Add a changeset if the change is user-facing (see below)
5. A new error code needs an entry in `src/error-codes.js`; then run `npm run error-codes:generate`

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full PR checklist.

### Changesets

Add a changeset for any change that affects users of the published npm package (new feature, bug fix, changed output). Skip for test-only, docs-only, or internal refactors.

Create `.changeset/<descriptive-name>.md`:

```markdown
---
"nansen-cli": patch
---

Short description (appears in CHANGELOG)
```

`patch` = bug fix, `minor` = new feature, `major` = breaking change.

## Browser authentication

Plain `nansen login` requests first-party `nansen:api` account permissions equivalent to an API key, including smart-alert CRUD and trade API calls under existing account/plan/endpoint checks. Wallet signing remains separately authorized. Existing OAuth/MCP `nansen:read` grants are not broadened.

## MCP client config

`src/mcp-client-config.json` is the one maintained source for the values that MCP client setup uses: the endpoint, the OAuth endpoint, the `NANSEN-API-KEY` header, the `nansen` server key, the API-key URLs and the exact `mcp-remote` pin (API-322). It lives here because this repo is public (every consumer can read it without a token) and because `nansen mcp install` / `verify` execute these values, so a bad value fails real tests.

| Artifact | Repo | How it follows the source | Drift check |
|---|---|---|---|
| `buildServerEntry()`, `NANSEN_MCP_URL`, `MCP_REMOTE_PIN`, `mcp verify` URLs | nansen-cli | Imports `src/mcp-client-config.js` at runtime | `src/__tests__/mcp-client-config.test.js` |
| README `## MCP` section | nansen-cli | Generated from `scripts/templates/readme-mcp.md` by `npm run mcp:generate` | Same test (`npm test`), or `npm run mcp:check` |
| Public docs page ([docs.nansen.ai/mcp/connecting](https://docs.nansen.ai/mcp/connecting)) | Docs source | Vendored copy, pinned to a commit of this file | Drift check in the docs source CI |
| `.dxt` `manifest.json` / `package.json` | nansen-mcp-dxt | Vendored copy, pinned to a commit of this file | nansen-mcp-dxt `npm run check` in CI |
| Webapp MCP setup page (account settings) | Webapp source | Vendored copy, pinned to a commit of this file; the page renders its snippets from it and recommends `nansen mcp install <client>` | Drift checks in the webapp source CI and a weekly check against the docs pin |

Never edit the generated README region by hand. `src/schema.json` stays manual; the test asserts its MCP URL. Other CLI messages (login, API errors, postinstall) still hard-code the API-key URLs; they are outside this config.

**Change a value:**

1. Edit `src/mcp-client-config.json`. The loader rejects non-HTTPS URLs, other hosts, trailing slashes, ranges and dist-tags.
2. Run `npm run mcp:generate`, then `npm test`.
3. After merge, re-sync the vendored copies to the merge commit on `main`: `npm run sync -- --ref <sha>` in nansen-mcp-dxt (this also rebuilds `nansen.dxt`), and the matching sync steps in the docs source and the webapp source. A new endpoint also needs the literal endpoint checks in the API-321 contract tests and the hand-written docs pages to change.

**Bump the `mcp-remote` pin (owner: MCP maintainers of this repo).** `.github/workflows/mcp-remote-pin.yml` runs `npm run mcp:check-pin` every Monday and opens the issue "mcp-remote pin is behind the latest release" (it comments again only when the report changes). The same workflow runs `npm run mcp:check-consumers`, which opens "MCP client config consumers are out of sync" when nansen-mcp-dxt pins an older copy of the config. The pin is never bumped automatically, because the bridge carries the API key on every request. To bump: pick a version that was published at least 7 days ago (the report names the newest one), then read the release notes and the source diff since the current pin. The report shows the npm provenance source (the repository that built each tarball), the declared repository and the current maintainers, so a change of owner is visible. Confirm that `${VAR}` header substitution still works, set `mcpRemote.version`, run steps 2–3 above, and connect with the new pin before you merge. First confirm with `curl` that your key works (a tool call, not only `initialize`): when the key header does not work, `mcp-remote` can start the interactive OAuth flow and open browser windows.

## Paid Access Rails

The Nansen API supports three auth paths. Pick the right one when answering setup questions:

- **Account credits** — browser sessions from `nansen login` or conventional API keys via `NANSEN_API_KEY` / explicit `nansen login --human`. Both use the account's existing permissions and credits. Browser storage is limited to the [documented preview scope](docs/browser-login.md#preview-platform-scope).
- **x402** (micropayment, native to this CLI) — `nansen wallet create` + fund with USDC on Base or Solana, or USDT0 on X Layer. The CLI signs the `Payment-Signature` header from the API's 402 `accepts` list (EIP-712 name+version are read from the server response), but only after a client-side policy guard passes: the scheme must be supported, the `(network, asset)` pair must be a known Nansen payment token, Solana/SVM tokens must match the exact CAIP-2 network binding, and the amount must not exceed the per-payment USD cap (default `$1.00`, override with `NANSEN_X402_MAX_AMOUNT=<usd>` or `unlimited`; optional recipient allowlist via `NANSEN_X402_ALLOWED_PAYTO`). An optional per-process cumulative cap, `NANSEN_X402_SESSION_MAX_AMOUNT=<usd>` (environment only; unset or `unlimited` = no limit, an invalid value refuses every payment), bounds what one `nansen` invocation signs across its retries, fallbacks and concurrent requests. It resets with every process, so it does not limit spending across separate runs. A charge is released when signing fails or the server cleanly rejects the payment; an accepted or ambiguous payment stays counted. A persisted daily cap, `NANSEN_X402_DAILY_MAX_AMOUNT=<usd>` (default `$50.00`, `unlimited` to disable, an invalid value refuses every payment), bounds what all `nansen` processes sign per UTC day. It counts each payment when it is about to be signed and, like the session cap, takes it back only when signing fails or the server cleanly rejects it; an accepted, abandoned or ambiguous payment stays counted (over-counting is the safe direction). The total lives in `~/.nansen/x402/spend-YYYY-MM-DD.json` under a cross-process lock, and an unreadable ledger or lock timeout refuses the payment (`src/x402-spend-ledger.js`). Unsupported schemes, unknown pairs, network mismatches, or over-cap amounts are refused without signing. Each signed auto-payment and its outcome (accepted, rejected or ambiguous) are appended to `~/.nansen/x402/payments.jsonl` (best-effort; `src/x402-audit.js`). See `src/x402-policy.js`, `src/x402.js`, and the `--x402-payment-signature` flag.
- **MPP via tempo** (micropayment, separate CLI) — handled by the [tempo CLI](https://docs.tempo.xyz), not by `nansen-cli`. Triggered when the client sends `Authorization: Payment ...`; the Nansen API responds with `WWW-Authenticate: Payment ...` and a `Payment-Receipt` header on success. Direct users to install tempo separately and call the API via `tempo request`. See `skills/nansen-mpp-payment/SKILL.md`.

MPP is a separate payment rail on the Nansen API (server-side toggled via `MPP_ENABLED=true`); `nansen-cli` does **not** sign MPP credentials in-process. Don't add an `--mpp-*` flag or shell out to tempo unless explicitly asked — the user's intended UX is "install tempo separately, use it side-by-side with `nansen-cli`".

## Input validation and errors

Every research command (`research ...` and the deprecated top-level `token`, `profiler`, `smart-money`, `portfolio`, `search`, `prediction-market`, plus `perp screener|leaderboard`) goes through `src/input-validation.js` before any request (API-1080, API-1081). It rejects unknown subcommands and options (with the closest match), options given without a value, missing required options, bad enum/number/date values and chains the endpoint does not accept. Do not add a second validation path in a handler; extend the schema or this module.

- **Source of truth:** a leaf's `options` in `src/schema.json`, plus `type`, `aliases`, `required`/`requiredUnless`, `positional`, `repeatable`, `format` (`date`, `date-time`, `json`), `enum`, and `"pagination": false` for endpoints without pagination (`--limit`/`--page`/`--paginate` are then rejected). `src/__tests__/input-validation.test.js` runs every research command once per option and fails if an option is accepted but not sent, or is sent under a request field that the endpoint does not list in `src/api-endpoints.json`. An option that only changes what the CLI does with the response goes in `CLIENT_SIDE_OPTIONS` there.
- **Chains:** chain values are lowercased and the REST API's aliases applied (`bsc` -> `bnb`, `eth` -> `ethereum`, see `CHAIN_ALIASES`) before the check and the request. `src/api-endpoints.json` lists each endpoint's chains and request fields, vendored from the public OpenAPI spec. Refresh with `npm run endpoints:sync`; `npm run endpoints:check` (weekly in `.github/workflows/api-endpoints.yml`) reports drift. `nansen schema` shows them as `supportedChains`.
- **Error shape:** `{ success: false, error, code, status, requestId?, details }`, exit 1. `details.errors[]` is `{ field, message, code }` with the API's snake_case field codes; wording mirrors the REST API ("... is not recognized. Did you mean ...?"). Every `code` is listed in `src/error-codes.js` and `docs/error-codes.md` (generated; `npm test` fails when stale).
- **Connection vs key:** `NETWORK_ERROR` means the API was not reached and the key was not checked; `UNAUTHORIZED` means the API rejected the key. Keep the messages saying so.

## API Endpoint Quirks

Behaviors that are not bugs — don't "fix" them:

- `token holders --smart-money` → API returns `UNSUPPORTED_FILTER` for tokens without SM tracking
- `token flow-intelligence` → may return all-zero flows for illiquid tokens
- `token screener --search` → client-side filtering (fetches 500, filters locally). `_meta.search.complete: false` in the response (plus a stderr note) means the window was full and lower-ranked tokens were never searched — an empty result is not proof the token is absent
- `token ohlcv` → no pagination/limit support; returns all candles for the timeframe (the CLI rejects `--limit`/`--page`)
- `profiler perp-positions` → no pagination support (the CLI rejects `--limit`/`--page`)
- `smart-money netflow` → response always includes all timeframes; there is no `--timeframe` option
- `token screener --chain bitcoin` → the endpoint accepts bitcoin but may return no rows; native BTC on token endpoints is `1111111111111111111114oLvT2`
- `nansen research search` → matches by name, symbol, or address; use `profiler labels` for richer address metadata
- `--chain bnb` → accepted as input but response `chain` field returns `bsc`
