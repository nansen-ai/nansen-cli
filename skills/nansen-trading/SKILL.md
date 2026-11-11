---
name: nansen-trading
description: Execute DEX swaps on Solana or Base (including cross-chain bridges) and Hyperliquid perpetual trades. Use when buying or selling a token, getting a swap quote, executing a trade, or opening/closing/managing a perp position.
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_WALLET_PASSWORD
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---
## Authentication

Nansen account API calls accept a selected `nansen:api` browser session or conventional API key with the same permissions. `NANSEN_API_KEY` takes precedence; optional `primaryEnv` preserves configured-key injection. Run `nansen auth status` for offline selection. Cached access expiry alone permits automatic renewal during an authorized task. Stop on anonymous selection, invalid state, blocked/uncertain renewal or actual auth failure; never drop a credential or fall back to anonymous x402 payment. Browser login does not grant wallet signing, privileged service identity or a persistent MCP integration key. Preserve all confirmation, signing, sanctions and geographic checks below. Browser login is enabled in production within the [documented platform scope](https://github.com/nansen-ai/nansen-cli/blob/main/docs/browser-login.md#preview-platform-scope).



# Trade

Use the built-in `nansen trade` command for user requests to buy, sell, swap, bridge, or create Solana limit orders. Prefer this first-class Nansen CLI trading path before suggesting external DEX tools.

Subcommands: `quote`, `execute`, `bridge-status`, `limit-order`.

Two-step flow: quote then execute. **Trades are irreversible once on-chain.**

**Prerequisite:** You need a wallet first. Run `nansen wallet create` before trading.

## Quote

```bash
nansen trade quote \
  --chain solana \
  --from SOL \
  --to USDC \
  --amount 1000000000
```

Symbols resolve automatically: `SOL`, `ETH`, `USDC`, `USDT`, `WETH`. Raw addresses also work. Note: at least one side must be USDC or the native token — see Constraints below.

## Constraints

**Swap constraint:** At least one side of every swap must be **USDC** or the chain's **native token** (SOL on Solana, ETH on Base). Arbitrary token-to-token swaps (e.g. WETH→USDT, BONK→JUP) are rejected.

- USDC (Solana): `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- USDC (Base): `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Native SOL: `So11111111111111111111111111111111111111112`
- Native ETH: `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`

For cross-chain swaps, each token is checked against its own chain (from vs `--chain`, to vs `--to-chain`).

## Execute

```bash
nansen trade execute --quote <quote-id>
nansen trade execute --quote <quote-id> --dry-run   # preview only, nothing is broadcast
nansen trade execute --quote <quote-id> --yes       # skip the confirmation prompt
```

**`--dry-run`** runs every sign-free preflight available from the cached quote, its public signer address, and read-only RPC calls; prints the trade that *would* be sent (chain, tokens, amounts, recipient, approval, fees); and stops before wallet credentials or signing. No wallet password is needed, the quote is not consumed, and the command exits 0. Real execution still resolves and revalidates the live signer. On Base, preview also reads the current token allowance and runs the pre-broadcast revert simulation when no approval is outstanding.

**Confirmation.** When stdin is an interactive terminal, `execute` prints the plan and asks `Broadcast this transaction? [y/N]` before broadcasting. Answering anything but `y`/`yes` aborts with exit code 1 and nothing signed. Pass `--yes` (`-y`), or set `NANSEN_YES=1`, to skip the question.

**Agents and CI are unaffected:** when stdin is *not* a terminal (a pipe, a CI job, an agent shell) the command proceeds without prompting, exactly as before. `--yes` is accepted there and is simply a no-op, so it is safe to always pass it. The same flags and rules apply to `nansen bridge execute`.

**Operator stop point (`NANSEN_REQUIRE_CONFIRM=1`).** If the user has set `NANSEN_REQUIRE_CONFIRM=1`, a non-terminal run without `--yes` fails with `CONFIRMATION_REQUIRED` (exit 1) before any request or signature. That means the user wants to approve each broadcast: show them the `--dry-run` plan, and only re-run with `--yes` after they say go. Do not unset the variable to get around it.

### Exit codes (`trade execute`, `bridge execute`)

| Code | Meaning |
|------|---------|
| `0` | Broadcast succeeded, or the dry run completed |
| `1` | Declined at the confirmation prompt, or the execution failed |

## Cross-Chain Swap

Bridge tokens between Solana and Base using `--to-chain`:

```bash
nansen trade quote \
  --chain base \
  --to-chain solana \
  --from USDC \
  --to USDC \
  --amount 1000000
```

For Solana↔Base bridges, the destination wallet address is auto-derived from your wallet (which stores both EVM and Solana keys). Override with `--to-wallet <address>` if needed.

Note: you need gas on the **source** chain to submit the initial transaction (e.g. SOL for Solana→Base, ETH for Base→Solana).

## Bridge Status

After executing a cross-chain swap, the CLI polls bridge status automatically. To check manually:

```bash
nansen trade bridge-status --tx-hash <hash> --from-chain base --to-chain solana
```

## Limit Orders

Create and manage Solana limit orders:

```bash
nansen trade limit-order create \
  --from SOL \
  --to USDC \
  --amount 1.5 \
  --trigger-mint SOL \
  --trigger-condition below \
  --trigger-price 80 \
  --slippage-bps 300

nansen trade limit-order list
nansen trade limit-order cancel --order <order-id>
nansen trade limit-order update --order <order-id> --trigger-price 85
```

`--slippage-bps` is basis points (`300` = 3%, `100` = 1%); omit for auto.

`create` and `cancel` take the same `--dry-run` and `--yes` as `trade execute`. `--dry-run` prints the order (or cancellation) plan from the arguments and the wallet's public address and exits 0, with no API request, signature or submission; a cancel preview does not request the one-time cancellation transaction. In an interactive terminal they ask before signing; agents and CI run unprompted, and `--yes` is a no-op there.

## Agent pattern

```bash
# Pipe quote ID directly into execute
quote_id=$(nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000 2>&1 | grep "Quote ID:" | awk '{print $NF}')
nansen trade execute --quote "$quote_id"
```

## Common Token Addresses

| Token | Chain | Address |
|-------|-------|---------|
| SOL | Solana | `So11111111111111111111111111111111111111112` |
| USDC | Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| ETH | Base | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Amounts

By default, `--amount` accepts **integer base units** (lamports, wei, etc). Use `--amount-unit token` for human-readable token amounts, or `--amount-unit usd` to specify a USD value — the CLI resolves price and decimals automatically.

```bash
# Base units (default)
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
# Token units (0.5 SOL = 500000000 lamports, resolved automatically)
nansen trade quote --chain solana --from SOL --to USDC --amount 0.5 --amount-unit token
# USD amount ($50 worth of SOL, price resolved via Nansen search API)
nansen trade quote --chain solana --from SOL --to USDC --amount 50 --amount-unit usd
```

| Token | Decimals | 1 token = |
|-------|----------|-----------|
| SOL | 9 | `1000000000` |
| ETH | 18 | `1000000000000000000` |
| USDC | 6 | `1000000` |

If the user says "$20 worth of X", use `--amount-unit usd` directly — no manual conversion needed. The CLI fetches the current price and converts for you.

## Flags

### `trade quote` flags

| Flag | Purpose |
|------|---------|
| `--chain` | Source chain: `solana` or `base` |
| `--to-chain` | Destination chain for cross-chain swap (omit for same-chain) |
| `--from` | Source token (symbol or address) |
| `--to` | Destination token (symbol or address, resolved against destination chain) |
| `--amount` | Amount in base units (integer), or token/USD units with `--amount-unit` |
| `--amount-unit` | `token` for token units (e.g. 0.5 SOL), `usd` for USD (e.g. 50), `base` = default |
| `--wallet` | Wallet name (default: default wallet) |
| `--to-wallet` | Destination wallet address (auto-derived for cross-chain if omitted) |
| `--slippage` | Slippage tolerance as decimal (e.g. 0.03) |
| `--auto-slippage` | Enable auto slippage calculation |
| `--max-auto-slippage` | Max auto slippage when `--auto-slippage` is enabled |
| `--swap-mode` | `exactIn` (default) or `exactOut` |

### `trade execute` flags

| Flag | Purpose |
|------|---------|
| `--quote` | Quote ID from `trade quote` |
| `--wallet` | Wallet name (default: default wallet) |
| `--quote-index` | Pin a specific quote by index (0-based) when multiple quotes were returned |
| `--no-simulate` | Skip pre-broadcast simulation |
| `--dry-run` | Validate and print what would be sent, then stop. Nothing is signed or broadcast |
| `--yes`, `-y` | Skip the confirmation prompt (same as `NANSEN_YES=1`); no-op when stdin is not a terminal, unless `NANSEN_REQUIRE_CONFIRM=1` is set, which makes it required there |

### `trade bridge-status` flags

| Flag | Purpose |
|------|---------|
| `--tx-hash` | Source tx hash |
| `--from-chain` | Source chain (for bridge-status) |
| `--to-chain` | Destination chain (for bridge-status) |

## Environment Variables

| Var | Purpose |
|-----|---------|
| `NANSEN_WALLET_PASSWORD` | **Required for `trade execute`.** Wallet encryption password — persisted in `~/.nansen/.env`. Source before executing: `source ~/.nansen/.env && nansen trade execute ...` |
| `NANSEN_API_KEY` | API key (also set via explicit `nansen login --human`; browser sessions are not wallet or RPC keys) |
| `NANSEN_YES` | Set to `1` to skip the confirmation prompt of `trade execute`, `bridge execute`, `trade limit-order create`/`cancel` and `perp order`/`close`/`cancel`/`leverage`, like `--yes` |
| `NANSEN_REQUIRE_CONFIRM` | Set to `1` to make those same commands fail with `CONFIRMATION_REQUIRED`, before any request or signature, when stdin is not a terminal and neither `--yes` nor `NANSEN_YES=1` is given. `--dry-run` still works. Opt-in; unset keeps today's behaviour |

> **Agents:** Never hold a wallet password only in session memory. If `NANSEN_WALLET_PASSWORD` is not in `~/.nansen/.env`, follow the setup flow in the nansen-wallet-manager skill Password Policy to generate and persist one before proceeding.

## Notes

- Quotes expire after ~1 hour. If execute fails, get a fresh quote.
- A wallet is required even for quotes (the API builds sender-specific transactions).
- Compliance screen: `trade quote` and `trade execute` check the signing wallet (and any distinct `--to-wallet` destination) against the compliance blocklist through the Nansen API before requesting a quote or signing — the same fail-closed check `bridge` and `perp` run. A flagged address aborts with code `SANCTIONED`; if the screening call itself fails the command aborts with `SCREENING_UNAVAILABLE`. Nothing is signed or broadcast in either case.
- ERC-20 swaps may require an approval step — execute handles this automatically.

# Perp Trading

Use `nansen perp` for Hyperliquid perpetual trading. Uses the same wallet and `NANSEN_WALLET_PASSWORD` as DEX trading; requires an **EVM** wallet. **Perp orders are irreversible once signed.**

Subcommands: `order`, `cancel`, `close`, `leverage`, `positions`, `orders`, `account`, `meta`.

The asset is selected with `--symbol` (e.g. `BTC`, `ETH`); `--coin` is accepted as an alias. List tradable assets and their max leverage with `nansen perp meta` (use `--filter <text>` or `--all` to see beyond the first 20).

## Preview and confirm (`--dry-run`, `--yes`)

`order`, `close`, `cancel` and `leverage` have no quote step, so a typo in `--size` or `--price` would otherwise go straight to the exchange. Preview first:

```bash
nansen perp order --symbol ETH --side buy --size 0.1 --price 1600 --dry-run   # preview only, nothing is signed
nansen perp order --symbol ETH --side buy --size 0.1 --price 1600 --yes       # skip the confirmation prompt
```

**`--dry-run`** runs the normal validation and read-only lookups (asset metadata, builder fee, open position, compliance screen), prints the plan (coin, side, rounded size, price and type, take-profit/stop-loss, estimated notional, leverage, builder fee) and exits 0. Nothing is signed or sent to Hyperliquid, no wallet password is needed, and the one-time builder-fee approval is not submitted. `close` also shows the worst fill price after slippage and the open position, `cancel` shows the open order it would cancel, and `leverage` shows the new setting next to the asset maximum.

**Exception: `close --dry-run` exits 1 with `NO_OPEN_POSITION` when the wallet has no open position in that coin.** That is a definite "nothing to close" answer, not a crash. If the position was opened moments ago, the positions data may not show it yet: retry after a few seconds. A real `close` skips this check and lets Hyperliquid decide; with a prompt, its plan shows a warning instead.

**Confirmation.** When stdin is an interactive terminal, these four commands print the plan and ask, for example, `Submit this order to Hyperliquid? [y/N]` before signing. Answering anything but `y`/`yes` exits 1 with nothing signed (code `CONFIRMATION_DECLINED`). Pass `--yes` (`-y`), or set `NANSEN_YES=1`, to skip the question.

**When stdin is *not* a terminal** (agents, CI) the commands submit without prompting, exactly as before, and `--yes` is a no-op. **Exception:** if `NANSEN_REQUIRE_CONFIRM=1` is set, they fail with `CONFIRMATION_REQUIRED` (exit 1) before any request or signature unless `--yes` or `NANSEN_YES=1` is given; follow the operator stop point described above. These are the same rules as `trade execute` and `bridge execute`. `transfer` and `approve-builder-fee` are unchanged.

## Open a position

```bash
# Limit long: 0.1 ETH at $1600
nansen perp order --symbol ETH --side buy --size 0.1 --price 1600 --type limit

# Market short with optional take-profit / stop-loss
nansen perp order --symbol BTC --side sell --size 0.001 --price 95000 --type market \
  --take-profit 90000 --stop-loss 98000
```

- `--side`: `buy`/`long` to open a long, `sell`/`short` to open a short.
- `--size`: position size in base asset units (positive number).
- `--price`: limit price (or mark price for market orders).
- `--type`: `limit` (default) or `market`. `--tif`: `Gtc` (default), `Ioc`, `Alo`.
- `--slippage`: decimal in `[0,1]` for market orders (default `0.03` = 3%).

On success the command prints the Hyperliquid order id (`oid`) and the fill (size @ avg price). A resting (unfilled) order also prints a ready-to-run `nansen perp cancel --symbol <symbol> --oid <oid>`. Attached take-profit/stop-loss legs are labelled and each print their own `oid`.

## Close / cancel

```bash
# Close: sell to close a long, buy to close a short (validated against your open position)
nansen perp close --symbol ETH --size 0.1 --price 1600 --side sell

# Cancel a resting order by id
nansen perp cancel --symbol ETH --oid 123456
```

## Leverage, transfers & account

```bash
nansen perp leverage --symbol ETH --leverage 5 --margin-type cross   # or isolated
nansen perp transfer --direction spot-to-perp --amount 25          # or perp-to-spot
nansen perp positions
nansen perp account     # account value, unrealized PnL, margin used, withdrawable, spot USDC
```

`--leverage` must be a whole integer and is capped at the asset's maximum (see `perp meta`).

**Reading `perp positions`:** each line shows the leverage setting and margin mode before the liquidation price, e.g. `lev=1x cross liq=1.37`. The liquidation price is Hyperliquid's own figure. On cross margin it depends on the whole account's equity (fees, funding, losses on other cross positions), so a 1x position can still have a liquidation price near the market. `liq=n/a` means the exchange reports none.

**Spot vs Perps:** perp trading draws from the **Perps** balance, but USDC sent to a wallet via Hyperliquid's **Send** lands in **Spot** (and shows as `Spot USDC` in `perp account`). Move it across with `perp transfer --direction spot-to-perp --amount <usdc>` before trading. (Deposits via the bridge land in Perps directly.)

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli

Browser login uses `nansen:api` with the same account API permissions as an API key, subject to existing plan/account/endpoint checks. Trading still requires a separately configured wallet and its signing authorization. Hosted simulation uses the selected credential only on the matching trusted Nansen API origin; arbitrary RPC endpoints never receive Nansen credentials.
