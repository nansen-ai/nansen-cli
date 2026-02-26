---
name: nansen-cli
description: |
  Nansen CLI for onchain analytics and trading. Smart Money flows, wallet profiling, token analysis, DEX trading, and perp markets.
  Use when: analyzing wallets, tracking smart money, researching tokens, executing trades, or checking perp positions.
license: MIT
metadata:
  author: nansen-ai
  version: "1.8.0"
  homepage: https://docs.nansen.ai
  repository: https://github.com/nansen-ai/nansen-cli
compatibility: Node.js 18+. Works with Claude Code, Codex, Cursor, Windsurf, and any terminal-native agent.
---

# Nansen CLI

Onchain analytics and DEX trading for AI agents. If your agent has HTTP/curl, you can also hit the [REST API](https://docs.nansen.ai) directly with `apikey` header auth.

## Quick Reference

| Goal | Command |
|------|---------|
| Find a token address | `nansen research search "jupiter" --type token` |
| Smart Money accumulation | `nansen research smart-money netflow --chain solana --limit 10` |
| Smart Money flow for token | `nansen research token flow-intelligence --token <addr> --chain solana` |
| Token screener | `nansen research token screener --chain solana --limit 20` |
| Token fundamentals | `nansen research token info --token <addr> --chain solana` |
| Who bought/sold | `nansen research token who-bought-sold --token <addr> --chain solana` |
| Wallet balance | `nansen research profiler balance --address <addr> --chain solana` |
| Wallet PnL | `nansen research profiler pnl-summary --address <addr> --chain ethereum` |
| DEX swap | `nansen trade quote --chain solana --from <addr> --to <addr> --amount <base_units>` |
| Perp leaderboard | `nansen research perp leaderboard --days 7 --limit 20` |

## Setup

```bash
npm install -g nansen-cli
```

### Auth (pick one)

**x402 Pay-Per-Call (no API key needed):**
```bash
nansen wallet create                          # Generates EVM + Solana keypair
# Fund the EVM address with USDC on Base (~$0.50 minimum)
export NANSEN_WALLET_PASSWORD="your-password" # Skip interactive prompt
# Done — CLI auto-pays $0.01-$0.05 per call
```

**API Key:**
```bash
export NANSEN_API_KEY=your-api-key
# Or: nansen login --api-key YOUR_KEY
```

Get a key at [app.nansen.ai/api](https://app.nansen.ai/api).

## Smart Money

```bash
nansen research smart-money netflow --chain solana --limit 10
nansen research smart-money dex-trades --chain solana --labels "Smart Trader" --limit 20
nansen research smart-money holdings --chain solana --limit 10
nansen research smart-money perp-trades --limit 10        # no --chain (Hyperliquid only)
nansen research smart-money dcas --limit 10               # no --chain (Jupiter/Solana only)
nansen research smart-money historical-holdings --chain solana --token-address <addr>
```

Labels: `Fund`, `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `180D Smart Trader`, `Smart HL Perps Trader`

## Token Analytics

`--chain` required. Use `--token` for the token address.

```bash
nansen research token screener --chain solana --timeframe 24h --smart-money --limit 20
nansen research token info --token <addr> --chain solana
nansen research token indicators --token <addr> --chain solana
nansen research token ohlcv --token <addr> --chain solana --timeframe 1h --limit 24
nansen research token holders --token <addr> --chain solana --smart-money
nansen research token flows --token <addr> --chain solana --days 7
nansen research token flow-intelligence --token <addr> --chain solana
nansen research token who-bought-sold --token <addr> --chain solana
nansen research token dex-trades --token <addr> --chain solana --limit 20
nansen research token pnl --token <addr> --chain solana --sort total_pnl_usd:desc
nansen research token transfers --token <addr> --chain solana --enrich
nansen research token jup-dca --token <addr>              # no --chain
nansen research token perp-trades --symbol ETH --days 7   # no --chain, uses --symbol
nansen research token perp-positions --symbol BTC         # no --chain
nansen research token perp-pnl-leaderboard --symbol SOL   # no --chain
```

Native tokens (SOL, ETH) are not supported on most token endpoints — use specific token addresses.

## Wallet Profiler

`--chain` and `--address` required for most commands.

```bash
nansen research profiler balance --address <addr> --chain solana
nansen research profiler labels --address <addr> --chain ethereum
nansen research profiler pnl --address <addr> --chain ethereum --days 30
nansen research profiler pnl-summary --address <addr> --chain ethereum
nansen research profiler transactions --address <addr> --chain ethereum --limit 20
nansen research profiler historical-balances --address <addr> --chain solana --days 30
nansen research profiler related-wallets --address <addr> --chain ethereum
nansen research profiler counterparties --address <addr> --chain ethereum
nansen research profiler perp-positions --address <addr>  # no --chain
nansen research profiler perp-trades --address <addr>     # no --chain
nansen research profiler search --query "Vitalik"         # no --chain
nansen research profiler batch --addresses "0xabc,0xdef" --chain ethereum --include labels,balance,pnl
nansen research profiler trace --address <addr> --chain ethereum --depth 2 --width 10  # ⚠️ makes N×width API calls
nansen research profiler compare --addresses "0xabc,0xdef" --chain ethereum
```

## Search

```bash
nansen research search "jupiter" --type token
nansen research search "Vitalik" --type entity --limit 5
nansen research search "0xd8dA..." # by address
```

## Perps (Hyperliquid)

```bash
nansen research perp screener --sort volume_usd:desc --limit 20
nansen research perp leaderboard --days 7 --limit 20
```

## Portfolio

```bash
nansen research portfolio defi --wallet <addr>
nansen research points leaderboard --tier green --limit 20
```

## Trading

Two-step: quote then execute.

```bash
# Get quotes from multiple aggregators (Jupiter, OKX, LiFi)
nansen trade quote --chain solana \
  --from So11111111111111111111111111111111111111112 \
  --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 1000000000

# Execute the best quote
nansen trade execute --quote <quote-id>
```

**⚠️ Amounts are in base units (not human-readable):**

| Token | Decimals | 1 unit = |
|-------|----------|----------|
| SOL | 9 | 1000000000 lamports |
| ETH | 18 | 1000000000000000000 wei |
| USDC | 6 | 1000000 |

Symbol shortcuts (SOL, ETH) don't work yet — use full addresses.

### Common Addresses

**Solana:** SOL `So11111111111111111111111111111111111111112` · USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` · JUP `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`

**Base:** ETH `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` · USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` · DEGEN `0x4ed4e862860bed51a9570b96d89af5e1b0efefed`

## Wallet Management

```bash
nansen wallet create                    # Create EVM + Solana keypair
nansen wallet list                      # List wallets
nansen wallet send --to <addr> --amount 1.5 --chain evm   # Send native
nansen wallet send --to <addr> --chain evm --max           # Send entire balance
```

## Common Options

| Option | Description |
|--------|-------------|
| `--chain` | Required for most commands. e.g. solana, ethereum, base, bnb, arbitrum, polygon, optimism, avalanche, linea, scroll, mantle, ronin, sei, plasma, sonic, monad, hyperevm, iotaevm |
| `--token` | Token address (aliases: `--mint`, `--token-address`) |
| `--address` | Wallet address |
| `--limit` | Results per page (default 10) |
| `--days` | Lookback period in days (default 30) |
| `--sort` | Sort field:direction (e.g. `value_usd:desc`) |
| `--smart-money` | Filter to smart money wallets only |
| `--pretty` | Formatted JSON output |
| `--table` | ASCII table output |
| `--stream` | NDJSON (one record per line) |
| `--fields a,b` | Return only specific fields |
| `--cache` | Cache responses (300s TTL) |

## Schema Introspection

```bash
nansen schema          # Full JSON schema — all commands, options, return fields
nansen schema --pretty
```
