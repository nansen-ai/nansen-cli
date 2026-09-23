# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Built by agents, for agents.** Command-line interface for the [Nansen API](https://docs.nansen.ai), designed for AI agents to research on-chain data, manage wallets, and trade through `nansen trade`.

Use it for both analytics and execution: `nansen research ...` returns structured on-chain data, while `nansen trade quote` / `nansen trade execute` handle DEX swaps on Solana and Base, including cross-chain bridges.

## Installation

```bash
npm install -g nansen-cli
npx skills add nansen-ai/nansen-cli  # load agent skill files
```

## Auth

Plain `nansen login` requests fresh browser approval and saves a session automatically. No API-key copying or PEM setup is needed. Selected sessions renew automatically; rejected or uncertain renewal requires fresh login.

```bash
nansen login                 # approve the displayed code, account and CLI
nansen login --no-browser    # same approval from a remote terminal
nansen auth status           # offline, cached/unverified credential selection
nansen account               # free live check, including with zero research credits
nansen logout                # clear saved API auth; preserve wallets and environment keys
```

Browser login requires working native credential storage and enabled server admission. Normal-release acceptance is pending; no published browser cohort is established by this branch. See [storage, supported scope and recovery](docs/browser-login.md). Email/password and Google sign-in are supported by the device-flow contract; employee-gated audiences require Google. Apple device sign-in remains deferred.

Existing API-key users can run commands directly with `NANSEN_API_KEY`. It overrides the saved session, even after successful browser login. To deliberately save an injected key, use explicit `nansen login --human`; without an environment key this prompts in a human terminal. `nansen login --api-key <key>` remains available but puts the key in shell history. Saved-auth mutations require the native lock binding. Get a conventional key at [agent setup](https://app.nansen.ai/auth/agent-setup); MCP installation exports a separate persistent API key; it does not export browser sessions.

Anonymous payment options remain separate:

- **x402:** create and fund a wallet with USDC on Base/Solana or USDT0 on X Layer. With no selected API key or browser session, the CLI can sign `Payment-Signature` on a supported 402 challenge. Selected credentials never trigger automatic payment, including a valid key returning 402. Top up the selected account or explicitly provide a manual API-key payment signature.
- **MPP:** install the separate tempo CLI and use `tempo request`. Browser login does not configure a wallet, sign MPP credentials or purchase credits. See [MPP / Tempo](#mpp--tempo).

## Verify your MCP setup

For the hosted Nansen MCP server, verify server reachability and the supplied API key on the paid data path with:

```bash
npx -y nansen-cli mcp verify  # uses the saved key or NANSEN_API_KEY
```

The check calls `tools/list` for reachability, then calls the paid `nansen_score_top_tokens` canary tool. A successful canary costs about 1 credit; tool listings and free tools alone do not prove that a key works. The CLI cannot inspect the key inside your MCP client, so make sure this same key is in the client's `NANSEN-API-KEY` header. For the final client-config check, ask your client: “Use the `nansen_score_top_tokens` tool.”

## Commands

```
nansen research <category> <subcommand> [options]
nansen agent "<question>"             # AI research agent (200 credits, Pro)
nansen agent "<question>" --expert    # deeper analysis (750 credits, Pro)
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
nansen trade execute --quote <quoteId>
nansen wallet <subcommand> [options]
nansen mcp install <client>           # add the Nansen MCP server to Claude Code/Desktop or Cursor
nansen completion <bash|zsh|fish>     # shell completions (no API key needed)
nansen schema [command] [--pretty]    # full command reference (no API key needed)
nansen cache stats                    # what the local caches hold (no API key needed)
```

**Research categories:** `smart-money` (`sm`), `token` (`tgm`), `profiler` (`prof`), `portfolio` (`port`), `prediction-market` (`pm`), `search`, `perp`

The points leaderboard API has been removed. `nansen research points leaderboard` and the legacy command `nansen points leaderboard` return `success: false` with code `COMMAND_UNAVAILABLE` and exit status `1`, without making an API request.

**Direct research subcommands:**
- `nansen research chain-rank [--timeframe-days 7|30|365] [--chain-type all|evm]` — rank chains by growth metrics
- `nansen research token-sectors` — list token sectors available for filtering
- `nansen research address-premium-labels --address <addr> [--chain <chain>] [--page <n>] [--limit <n>]` — get all labels for an address, including premium labels
- `nansen research smart-money-pnl-leaderboard [--chains c1,c2] [--timeframe-days 1|7|30|90|180] [--filters '<json>'] [--sort <field[:asc|desc]>] [--page <n>] [--limit <n>]` — rank smart money wallets by PnL
- `nansen research position-intelligence --symbol <symbol>` — aggregate Hyperliquid positions by trader cohort
- `nansen research perp-pnl-summary --address <addr> --from-date <date> --to-date <date>` — summarize realized Hyperliquid PnL for an address
- `nansen research transaction-with-token-transfer-lookup --transaction-hash <hash> [--chain <chain>] [--block-timestamp "YYYY-MM-DD HH:MM:SS"]` — look up a transaction and its token/NFT transfers

Plus the `historical-*` point-in-time commands — run `nansen research help` for the full list.

**Trade:** `quote`, `execute`, `bridge-status`, `limit-order` — DEX swaps on Solana and Base, cross-chain bridges, and Solana limit orders.

**Wallet:** `create`, `list`, `show`, `export`, `default`, `delete`, `send`, `forget-password`, `secure` — local or Privy server-side wallets (EVM + Solana).

Run `nansen schema --pretty` for the full subcommand and field reference.

## Browser login compatibility and scope

Browser login requests `nansen:api` for the same account/API permissions as a pasted API key, including smart-alert CRUD, public agent, portfolio, web, beta and existing trading API operations. The same endpoint ownership, plan, credit, quota, sanctions and geographic checks apply. Existing OAuth/MCP `nansen:read` grants keep their existing semantics. Wallet signing remains separate.

Plain `nansen login` always starts fresh browser approval, whether no credential, an environment key, a saved key or a saved session exists. It preflights secure storage, shows a link/code, verifies the approved account through the free account endpoint, then replaces the single saved API credential. `nansen login --no-browser` runs the same flow in a remote terminal. Non-TTY login and `--json` emit NDJSON pending and terminal events; the private device code and tokens are never printed.

`NANSEN_API_KEY` still overrides the saved session. Login verifies the new account independently and explains this override. Failed approval or installation preserves the previous selection. `nansen auth status` is offline and labels saved metadata as cached/unverified; `nansen account` checks the effective credential live. `nansen logout` removes saved API authentication and attempts family retirement, preserving wallets and environment keys. Remote revocation and physical deletion failures are reported separately.

This is a breaking change for scripts that used plain login to persist an environment key. Use explicit `nansen login --human` with that environment key, or `--api-key <key>` with its existing shell-history risk. Direct key-authenticated commands need no migration. Automatic wallet payment now requires anonymous access: even a valid selected API key returning 402 will not automatically buy credits or sign a payment. Top up the selected account or explicitly supply `--x402-payment-signature`. Selected invalid credentials never cause an account switch; intended anonymous payments and explicit manual API-key payments retain their behavior.

No published cohort or normal-release acceptance is claimed. The proposed initial preview is local macOS arm64 with an unlocked Keychain. Linux remote-terminal qualification is pending; Windows is excluded from that first preview. See the [platform scope](docs/browser-login.md#preview-platform-scope). Selected browser sessions renew automatically near expiry. A lost refresh response without a complete stored replacement requires fresh login; the consumed credential is never retried. There is no browser-only research route allowlist. Public API permission parity does not grant internal service identity or wallet signing authority. Account admission and non-account API admission remain separately gated and default off. Public local/remote walkthroughs, ledger evidence and OS verification remain gates. Read [browser login custody, compatibility and release gates](docs/browser-login.md) before cohort use. Browser sessions do not add wallet-signing authority and cannot be exported as MCP API keys.

## MCP

Connect any MCP client to Nansen's streamable HTTP server:

- **Endpoint:** `https://mcp.nansen.ai/ra/mcp`
- **Authentication:** `NANSEN-API-KEY` header
- **API key:** [app.nansen.ai/auth/agent-setup](https://app.nansen.ai/auth/agent-setup)

One-step install of the hosted [Nansen MCP server](https://docs.nansen.ai/mcp/overview) (`https://mcp.nansen.ai/ra/mcp`) into a local MCP client:

```bash
nansen mcp install claude-code       # ~/.claude.json (user scope)
nansen mcp install claude-desktop    # macOS/Windows only; bridges via pinned mcp-remote
nansen mcp install cursor            # ~/.cursor/mcp.json
nansen mcp install cursor --dry-run  # print what would be written (key redacted)
nansen mcp uninstall <client>        # remove the entry (add --dry-run to preview)
```

Uses the API key from `nansen login --human` / `NANSEN_API_KEY`; re-run `install` after rotating your key. Writes are merge-only and atomic: existing servers and settings are preserved, a `.bak` copy is written before every install or uninstall, and the CLI refuses to touch a config it can't parse. Note the client config stores the API key in plaintext — new files are created with `0600` permissions. Restart the client after installing.

**Manual setup**, for other clients or if you would rather not use the CLI — the paths below, and the connection docs at [docs.nansen.ai/mcp/connecting](https://docs.nansen.ai/mcp/connecting).

**One-command (Claude Code):**

```bash
claude mcp add --transport http nansen https://mcp.nansen.ai/ra/mcp --header "NANSEN-API-KEY: <your-key>"
```

**Manual (any streamable-HTTP client):** for example, add this to Cursor's `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nansen": {
      "url": "https://mcp.nansen.ai/ra/mcp",
      "headers": {
        "NANSEN-API-KEY": "<your-key>"
      }
    }
  }
}
```

**Manual (stdio-only clients):** use `mcp-remote` as a bridge. Keep the header name and value in a single `args` entry, and keep the key in `env` rather than in the argument list — `mcp-remote` substitutes `${NANSEN_API_KEY}` from the environment:

```json
{
  "mcpServers": {
    "nansen": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.2.1",
        "https://mcp.nansen.ai/ra/mcp",
        "--header",
        "NANSEN-API-KEY:${NANSEN_API_KEY}"
      ],
      "env": {
        "NANSEN_API_KEY": "<your-key>"
      }
    }
  }
}
```

`mcp-remote` is pinned to an exact version rather than `@latest` because the bridge handles your API key on every request, and `npx` would otherwise pull a new release automatically. `0.2.1` is the current release and the version this config is tested against; bumping it is safe — review the release and update the pin.

**Claude Tag (Claude in Slack):** an admin must attach a plugin whose `.mcp.json` points at `https://mcp.nansen.ai/ra/mcp` and add a custom credential allowing the host `mcp.nansen.ai`. See the [Claude Tag custom-connections documentation](https://claude.com/docs/claude-tag/admins/connections/custom). Per-user fallback: use Claude Code or Claude Desktop.

## Trading

DEX swaps on `solana` and `base`. Two-step: quote then execute.

```bash
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
nansen trade execute --quote <quoteId>
```

Cross-chain swaps work the same way — add `--to-chain`. Bridge providers (Li.Fi or Relay) are selected automatically based on best price.

```bash
nansen trade quote --chain base --to-chain solana --from ETH --to SOL --amount 0.0003 --amount-unit token
nansen trade execute --quote <quoteId>                # signed broadcast
nansen trade execute --quote <quoteId> --gasless      # Relay-only: solver pays gas
nansen trade bridge-status --tx-hash <hash> --from-chain base --to-chain solana
```

### Before broadcasting

`trade execute` and `bridge execute` move funds irreversibly, so both accept:

```bash
nansen trade execute --quote <quoteId> --dry-run   # validate + print the plan, broadcast nothing
nansen trade execute --quote <quoteId> --yes       # skip the confirmation prompt (also: -y)
```

`--dry-run` runs every sign-free preflight available from the cached quote, its public signer address, and read-only RPC calls; prints what *would* be sent (chain, tokens, amounts, recipient, approvals, fees); and stops before wallet credentials, signing, or broadcast — no wallet password needed, the quote stays usable, exit code 0. Real execution still resolves and revalidates the live signer before signing.

When stdin is an interactive terminal, execute prints that plan and asks `Broadcast this transaction? [y/N]` first; anything but `y`/`yes` aborts with exit code 1 and nothing signed. `--yes`, or `NANSEN_YES=1`, skips the question. **When stdin is not a terminal — agents, CI, pipes — nothing changes: the command proceeds without prompting**, and `--yes` is accepted as a no-op so it is always safe to pass.

| Exit code | Meaning |
|-----------|---------|
| `0` | Broadcast succeeded, or the dry run completed |
| `1` | Declined at the confirmation prompt, or the execution failed |

Amounts are in base units (lamports, wei) by default — use `--amount-unit token|usd|percent` for friendlier inputs. Common symbols (`SOL`, `ETH`, `USDC`, `USDT`) resolve automatically. A wallet is required — set one with `nansen wallet default <name>`.

## Limit Orders

Native price-triggered orders on **Solana**. Four subcommands:

```bash
nansen trade limit-order create \
  --from SOL --to USDC \
  --amount 1.5 \
  --trigger-mint SOL --trigger-condition below --trigger-price 80 \
  --slippage-bps 300 --expires 7d

nansen trade limit-order list                    # all orders
nansen trade limit-order list --state active     # only open
nansen trade limit-order list --state past       # filled or cancelled
nansen trade limit-order cancel --order <orderId>
nansen trade limit-order update --order <orderId> --trigger-price 85
```

`--amount` is in token units (`1.5` = 1.5 SOL). `--slippage-bps` is basis points (`300` = 3%, `100` = 1%); omit for auto. Minimum order value ~$10 (server-enforced). Local, Privy, and WalletConnect wallets all work.

For EVM chains, there's no native limit-order surface — pair an external venue's resting order with a `common-token-transfer` smart alert on the settlement wallet as a best-effort fill signal. See the `nansen-limit-orders` skill for details.

## Perpetuals

Hyperliquid perpetual trading via `nansen perp`. Uses the same wallet and `NANSEN_WALLET_PASSWORD` as DEX trading (requires an EVM wallet). Select the asset with `--coin` (`--symbol` is accepted as an alias).

```bash
nansen perp meta --filter ETH                                  # list assets + max leverage
nansen perp order --coin ETH --side buy --size 0.1 --price 1600 --type limit
nansen perp order --coin BTC --side sell --size 0.001 --price 95000 --type market \
  --take-profit 90000 --stop-loss 98000
nansen perp close --coin ETH --size 0.1 --price 1600 --side sell   # sell closes a long
nansen perp cancel --coin ETH --oid <orderId>
nansen perp leverage --coin ETH --leverage 5 --margin-type cross   # or isolated
nansen perp transfer --direction spot-to-perp --amount 25          # Spot<->Perps (or perp-to-spot)
nansen perp positions
nansen perp account                                            # value, unrealized PnL, margin, spot USDC
```

`--side` is `buy`/`long` or `sell`/`short` to open (`buy`/`sell` to close); `--tif` is `Gtc`/`Ioc`/`Alo`; `--slippage` is a decimal in `[0,1]`; `--leverage` is a whole integer capped at the asset max. Perp orders are irreversible once signed. USDC sent to a wallet via Hyperliquid's **Send** lands in the **Spot** balance (shown as `Spot USDC`); move it to Perps with `perp transfer` before trading. See the `nansen-trading` skill for details.

## Bridge

Move USDC between EVM chains and Hyperliquid via `nansen bridge`. Uses the same wallet and `NANSEN_WALLET_PASSWORD` as perps and DEX trading. Quotes are written to a local file and executed by id; execution signs and broadcasts.

```bash
nansen bridge quote --from-chain base --to-chain hyperliquid --from-token USDC --amount 1000000
nansen bridge execute --quote <quoteId>
nansen bridge execute --quote <quoteId> --dry-run                     # preview, nothing is broadcast
nansen bridge execute --quote <quoteId> --nonce 20 --priority-fee 5   # replace a stuck EVM deposit
nansen bridge status --request-id <id>
```

Supported routes: `base → hyperliquid` (deposit), and `hyperliquid → base`/`ethereum`/`arbitrum` (withdraw). Deposits broadcast an EVM transaction locally, so only Base is offered on the deposit side; run `nansen bridge help` for the current list. `--amount` is a base-unit integer by default; pass `--amount-unit token` for a human amount. `--recipient` defaults to the wallet's own EVM address. `--priority-fee`/`--max-fee` (gwei) and `--nonce` apply only to EVM deposit legs and let a stuck transaction be replaced. Bridge transfers are irreversible once signed, so `bridge execute` takes the same `--dry-run` and `--yes`/`NANSEN_YES` gate as `trade execute` (see [Before broadcasting](#before-broadcasting)); on a multi-step transfer, a dry run stops before the first step.

## Wallet

```bash
nansen wallet create --name my-wallet        # local keypair (EVM + Solana)
nansen wallet create --name my-wallet --provider privy  # server-side via Privy
nansen wallet list
nansen wallet default <name>
nansen wallet send --wallet <name> --to <addr> --amount <n> --chain <chain>
nansen wallet secure                         # move a saved password into the OS keychain
nansen wallet forget-password                # drop the saved password from every store
```

**Local wallets** are password-encrypted. Set `NANSEN_WALLET_PASSWORD` to skip the prompt.

**Privy wallets** are server-side — no password, no local key storage. Requires `PRIVY_APP_ID` and `PRIVY_APP_SECRET` env vars. Get credentials at [dashboard.privy.io](https://dashboard.privy.io).

## MPP / Tempo

The Nansen API supports [MPP](https://mpp.dev/protocol) (Tempo's stablecoin payment rail) as an alternative to API keys and x402. MPP is handled by the **separate** [tempo CLI](https://docs.tempo.xyz) — `nansen-cli` itself does not sign MPP credentials. You use the two CLIs side-by-side.

**One-time setup:**

```bash
# 1. Install the tempo CLI
curl -fsSL https://tempo.xyz/install | bash
# 2. Log in + fund the tempo wallet
tempo wallet login
tempo wallet fund     # follow the on-screen instructions to deposit USDC
```

**Calling the Nansen API via tempo:**

```bash
tempo request POST https://api.nansen.ai/api/v1/smart-money/netflow \
  --json '{"chains":["solana"],"pagination":{"page":1,"page_size":10}}'
```

`tempo request` handles the full `Authorization: Payment` challenge/response: on a 402 with `WWW-Authenticate: Payment ...` it signs a Tempo credential, retries, and surfaces the `Payment-Receipt` header on success.

**When to use which rail:**

| Situation | Rail |
|---|---|
| You have a subscription | API key |
| You want anonymous pay-per-call with a Base/Solana wallet you already manage | x402 (`nansen wallet`) |
| You hold USDT0 on X Layer and want to pay from there | x402 (`nansen wallet`) |
| You already use tempo for other paid APIs, or want micropayments without managing your own wallet keys | MPP (`tempo request`) |

> Note: MPP is server-side opt-in (`MPP_ENABLED=true` on the API). It's available on dev today and rolling out to prod — if `tempo request` returns a non-MPP 402, fall back to x402 or an API key.

## Shell Completions

Tab-completion for commands, subcommands, flags, and the values a flag accepts:

```bash
# bash
echo 'eval "$(nansen completion bash)"' >> ~/.bashrc
# or system-wide: nansen completion bash > /etc/bash_completion.d/nansen

# zsh
nansen completion zsh > "${fpath[1]}/_nansen" && compinit
# or, in ~/.zshrc after the compinit line: eval "$(nansen completion zsh)"

# fish
nansen completion fish > ~/.config/fish/completions/nansen.fish
```

The scripts are generated from the same schema as `nansen schema`, so they cover
every nested subcommand and stay in step with the CLI. Nothing is written to
disk and no network call is made — the script goes to stdout. Re-run the command
after upgrading the CLI to pick up new commands.

## Key Options

| Option | Description |
|--------|-------------|
| `--chain <chain>` | Blockchain to query |
| `--limit <n>` | Result count |
| `--timeframe <tf>` | Time window: `5m` `1h` `6h` `24h` `7d` `30d` |
| `--fields <list>` | Comma-separated fields (reduces response size); a bare name matches at any depth, a dotted path such as `data.results.address` only at that position |
| `--sort <field:dir>` | Sort results, e.g. `--sort value_usd:desc` |
| `--pretty` | Human-readable JSON |
| `--table` | Table format |
| `--stream` | NDJSON output for large results |
| `--paginate` | Fetch every page of a list command (alias `--all`); bound with `--max-pages <n>` (default 10; ignored without pagination) |
| `--labels <label>` | Smart Money label filter |
| `--smart-money` | Filter for Smart Money addresses only |
| `--cache` | Serve this invocation from the local cache (see [Caching](#caching)) |
| `--no-cache` | Bypass the cache for this invocation |
| `--debug` | Trace every HTTP request on stderr (see [Debugging](#debugging)) |

## Caching

Response caching is **off by default** and opt-in per invocation:

```bash
nansen research token screener --chain solana --cache              # cache this result
nansen research token screener --chain solana --cache --cache-ttl 60
nansen research token screener --chain solana --cache --no-cache   # veto: always live
```

`NANSEN_NO_CACHE=1` does the same as `--no-cache` without a flag, for wrappers
that cannot change the command line.

With `--cache` on, every read the CLI makes through the Nansen API client is
cached — all of `nansen research ...`, plus `alerts list` and `alerts get`.
Never cached: `account`, `web search`, `web fetch`, the `alerts`
create/update/toggle/delete commands, `agent`, every `trade`, `bridge`, `wallet`
and `mcp` command, and `perp` trading. The analytics commands `perp screener`
and `perp leaderboard` are cached.

Inspect and clear what is on disk:

```bash
nansen cache stats                 # entries, size, age, effective TTL per cache
nansen cache stats --json          # the same numbers as an object
nansen cache clear                 # delete cached API responses
nansen cache clear cost-map        # or update-check, or all
```

`nansen cache stats` reports totals and ages. It reads timestamp metadata but does not print cached payloads, request parameters, or cache keys. `nansen cache clear` deletes only files in the selected cache. Credentials, wallets, saved quotes, and config are never changed. CLI startup loads the saved config as usual.

| Cache | Location | TTL |
|-------|----------|-----|
| `responses` | `~/.nansen/cache` | `--cache-ttl`, default 300s |
| `cost-map` | `~/.nansen/cost-map.json` | 24h |
| `update-check` | `~/.nansen/update-check.json` | 24h |

## Debugging

`--debug` (or `NANSEN_DEBUG=1`) prints HTTP trace events to **stderr**, so stdout stays pure JSON/CSV and stays pipeable:

```bash
nansen research token screener --chain solana --debug
nansen research token screener --chain solana 2>trace.log | jq .   # trace to a file, JSON to jq
```

```
[nansen:debug] http.request method=POST url=https://api.nansen.ai/api/v1/token-screener attempt=1/4
[nansen:debug] http.response method=POST url=https://api.nansen.ai/api/v1/token-screener status=429 duration_ms=182 request_id=6f1c0f2a-0000-4000-8000-0000000000aa attempt=1
[nansen:debug] http.retry method=POST url=https://api.nansen.ai/api/v1/token-screener status=429 attempt=1 reason=retry-after delay_ms=1100 retry_after_ms=1000
[nansen:debug] http.request method=POST url=https://api.nansen.ai/api/v1/token-screener attempt=2/4
[nansen:debug] http.response method=POST url=https://api.nansen.ai/api/v1/token-screener status=200 duration_ms=143 request_id=6f1c0f2a-0000-4000-8000-0000000000ab attempt=2
```

Events: `http.request`, `http.response`, `http.retry`, `http.error`, `http.cache_hit` (answered from the local cache, no request made).

For `http.response`, `duration_ms` is the elapsed time from starting the attempt until response headers arrive (time to first byte / TTFB). It deliberately excludes downloading and parsing the response body. For `http.error`, `duration_ms` is the elapsed time until the transport failed before any response headers arrived.

**What the trace never contains.** No API keys, wallet keys, mnemonics or payment signatures; no `Authorization`, `apikey` or `Payment-Signature` header values (header values are not traced at all); no request or response bodies. Query-string values are blanked whenever the parameter name mentions a key, token, secret, signature, password or auth, and any remaining credential-shaped value is blanked too. This intentionally includes public identifiers under names such as `token` and `token_address`, so use the original command—not the trace alone—to confirm which token was queried. Redaction deliberately fails closed: bare 64-character hex URL segments and long opaque/base58 identifiers are hidden even when they are public transaction, block, or Solana signature identifiers, because they are indistinguishable from key material without endpoint-specific assumptions. Long values are truncated. Paste a trace into a bug report as-is — but a quick read before you share is always wise.

## Supported Chains

`algorand` `aptos` `arbitrum` `arc` `avalanche` `base` `bitcoin` `bitlayer` `bnb` `chiliz` `citrea` `ethereum` `gravity` `hyperevm` `hyperliquid` `injective` `iotaevm` `linea` `mantle` `mantra` `monad` `near` `optimism` `plasma` `polygon` `robinhood` `sei` `solana` `sonic` `stacks` `starknet` `stellar` `sui` `ton` `tron` `viction`

> Run `nansen schema` to get the current chain list (source of truth).

## Agent Tips

**Reduce token burn with `--fields`:**
```bash
nansen research smart-money netflow --chain solana --fields token_symbol,net_flow_usd --limit 10
```

**Use `--stream` for large results** — outputs NDJSON instead of buffering a giant array.

**Use `--paginate` to fetch every page** of a list command in one call instead of looping over `--page`:
```bash
nansen smart-money netflow --chain solana --limit 100 --paginate --max-pages 5
```
`--limit` is the page size and `--max-pages` (default 10; ignored without pagination) caps the number of requests — every page is a
separate, separately billed API call. Server completion metadata (`total_pages`, `total`, or
`is_last_page`) is honoured so a known final page is not fetched again. Rows are de-duplicated and
the response gains
`pagination: { page, pages_fetched, next_page, complete }`; when `complete` is `false`, resume with
`--page <next_page>`. The stderr credit summary totals the live page requests; cached pages are not
counted as charges. Traversal trusts the server's `total`; if a live dataset changes or reports
inconsistent totals while pages are being fetched, later rows can be omitted. Combine with
`--stream` for NDJSON.

**ENS names** work anywhere `--address` is accepted: `--address vitalik.eth`

## Output Format

> **Compatibility note:** `--table`, `--format csv`, and `--stream` now render an
> unambiguous descriptive top-level array (for example, `trades` or `holdings`)
> as one row per item, even without `--paginate`. Older versions rendered the
> enclosing response object as a single row. Envelopes with multiple candidate
> data arrays remain unexpanded.

```json
{ "success": true,  "data": <api_response> }
{ "success": false, "error": "message", "code": "ERROR_CODE", "status": 401, "requestId": "...", "details": { ... } }
```

**Critical error codes:**

| Code | Action |
|------|--------|
| `CREDITS_EXHAUSTED` | Stop all API calls immediately. `details.credits.remaining` is your actual balance. Top up at [app.nansen.ai/api?tab=api](https://app.nansen.ai/api?tab=api). |
| `UNAUTHORIZED` | Wrong or missing key. Re-auth. |
| `RATE_LIMITED` | Auto-retried by CLI. `details.rateLimit.resetSeconds` is how long the window needs to drain. |
| `UNSUPPORTED_FILTER` | Remove the filter and retry. |
| `PLAN_UPGRADE_REQUIRED` | The endpoint or option needs a higher subscription plan. Do not retry. |
| `GEO_BLOCKED` | Not available in your region. Do not retry. |
| `SERVER_ERROR` | Not your fault. Quote `details.requestId` when reporting it. |
| `COMMAND_UNAVAILABLE` | The command is no longer available. For points leaderboard, run `nansen research` to explore other analytics commands. |

Every code documented on the API's [error-handling page](https://docs.nansen.ai/getting-started/error-handling) maps onto a stable CLI error code; a code the CLI does not recognise is passed through unchanged.

**Error metadata.** When the API reports them, `details` carries:

| Field | Meaning |
|-------|---------|
| `requestId` | Identifies this call end to end. Quote it in any support report. Opaque — do not parse it. Also hoisted to the top level of the error envelope. |
| `credits` | `used`, `remaining`, `cost` (the authoritative charge for this call) |
| `rateLimit` | `limit`, `remaining`, `resetSeconds` |

Any field may be absent or `null`, meaning unknown — never assume zero. A low-balance warning goes to **stderr**, so stdout stays pure JSON.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `command not found` | `npm install -g nansen-cli` |
| Global install reports an older version | `npm i -g nansen-cli@latest --registry=https://registry.npmjs.org/ --prefer-online`, then check `which -a nansen` for stale binaries |
| `UNAUTHORIZED` after login | `nansen auth status` shows the effective credential and cached/unverified session metadata. Correct an invalid environment key first; browser login does not override it. Use fresh `nansen login` for a rejected session, or explicit legacy key setup for integration credentials |
| MCP client lists tools but paid calls fail | Run `npx -y nansen-cli mcp verify` with the saved key or `NANSEN_API_KEY`, and ensure that same key is in the client's `NANSEN-API-KEY` header |
| Anything else misbehaving | `nansen doctor` checks your whole setup (auth, wallets, caches, connectivity) with a fix per finding |
| Empty perp _research_ results | Use `--symbol BTC`, not `--token`. Perps are Hyperliquid-only. |
| `perp` _trading_ prints the usage banner | Trading needs `--coin BTC` (`--symbol` also works); see the Perpetuals section. |
| `UNSUPPORTED_FILTER` on token holders | Remove `--smart-money` — not all tokens have that data. |
| Huge JSON response | Use `--fields` to select columns. |

## Development

```bash
npm test              # mocked tests, no API key needed
npm run test:live     # live API (needs NANSEN_API_KEY)
```

See [AGENTS.md](AGENTS.md) for architecture and contributor guidance.

## License

[MIT](LICENSE) © [Nansen](https://nansen.ai)
