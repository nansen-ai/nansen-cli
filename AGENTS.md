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
- **Operational commands** (trade, wallet, login) — print human-readable text via `log()` to stdout, return `undefined`
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
3. Update `src/schema.json` if you added/changed commands or options (manually maintained, no codegen)
4. Add a changeset if the change is user-facing (see below)

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

Never edit the generated README region by hand. `src/schema.json` stays manual; the test asserts its MCP URL. Other CLI messages (login, API errors, postinstall) still hard-code the API-key URLs; they are outside this config.

**Change a value:**

1. Edit `src/mcp-client-config.json`. The loader rejects non-HTTPS URLs, other hosts, trailing slashes, ranges and dist-tags.
2. Run `npm run mcp:generate`, then `npm test`.
3. After merge, re-sync the vendored copies to the merge commit on `main`: `npm run sync -- --ref <sha>` in nansen-mcp-dxt (this also rebuilds `nansen.dxt`), and the matching sync step in the docs source. A new endpoint also needs the literal endpoint checks in the API-321 contract tests and the hand-written docs pages to change.

**Bump the `mcp-remote` pin (owner: MCP maintainers of this repo).** `.github/workflows/mcp-remote-pin.yml` runs `npm run mcp:check-pin` every Monday and opens the issue "mcp-remote pin is behind the latest release" (it comments again only when the report changes). The same workflow runs `npm run mcp:check-consumers`, which opens "MCP client config consumers are out of sync" when nansen-mcp-dxt pins an older copy of the config. The pin is never bumped automatically, because the bridge carries the API key on every request. To bump: pick a version that was published at least 7 days ago (the report names the newest one), then read the release notes and the source diff since the current pin. The report shows the npm provenance source (the repository that built each tarball), the declared repository and the current maintainers, so a change of owner is visible. Confirm that `${VAR}` header substitution still works, set `mcpRemote.version`, run steps 2–3 above, and connect with the new pin before you merge. First confirm with `curl` that your key works (a tool call, not only `initialize`): when the key header does not work, `mcp-remote` can start the interactive OAuth flow and open browser windows.

## Paid Access Rails

The Nansen API supports three auth paths. Pick the right one when answering setup questions:

- **API key** (subscription) — `nansen login --human` / `NANSEN_API_KEY`. Default for subscribed users.
- **x402** (micropayment, native to this CLI) — `nansen wallet create` + fund with USDC on Base or Solana, or USDT0 on X Layer. The CLI signs the `Payment-Signature` header from the API's 402 `accepts` list (EIP-712 name+version are read from the server response), but only after a client-side policy guard passes: the scheme must be supported, the `(network, asset)` pair must be a known Nansen payment token, Solana/SVM tokens must match the exact CAIP-2 network binding, and the amount must not exceed the per-payment USD cap (default `$1.00`, override with `NANSEN_X402_MAX_AMOUNT=<usd>` or `unlimited`; optional recipient allowlist via `NANSEN_X402_ALLOWED_PAYTO`). Unsupported schemes, unknown pairs, network mismatches, or over-cap amounts are refused without signing. See `src/x402-policy.js`, `src/x402.js`, and the `--x402-payment-signature` flag.
- **MPP via tempo** (micropayment, separate CLI) — handled by the [tempo CLI](https://docs.tempo.xyz), not by `nansen-cli`. Triggered when the client sends `Authorization: Payment ...`; the Nansen API responds with `WWW-Authenticate: Payment ...` and a `Payment-Receipt` header on success. Direct users to install tempo separately and call the API via `tempo request`. See `skills/nansen-mpp-payment/SKILL.md`.

MPP is a separate payment rail on the Nansen API (server-side toggled via `MPP_ENABLED=true`); `nansen-cli` does **not** sign MPP credentials in-process. Don't add an `--mpp-*` flag or shell out to tempo unless explicitly asked — the user's intended UX is "install tempo separately, use it side-by-side with `nansen-cli`".

## API Endpoint Quirks

Behaviors that are not bugs — don't "fix" them:

- `token holders --smart-money` → API returns `UNSUPPORTED_FILTER` for tokens without SM tracking
- `token flow-intelligence` → may return all-zero flows for illiquid tokens
- `token screener --search` → client-side filtering (fetches 500, filters locally). `_meta.search.complete: false` in the response (plus a stderr note) means the window was full and lower-ranked tokens were never searched — an empty result is not proof the token is absent
- `token ohlcv` → no pagination/limit support; returns all candles for the timeframe
- `profiler perp-positions` → no pagination support; API ignores the parameter
- `smart-money netflow --timeframe` → silently accepted but has no effect; response always includes all timeframes
- `nansen research search` → matches by name, symbol, or address; use `profiler labels` for richer address metadata
- `--chain bnb` → accepted as input but response `chain` field returns `bsc`
