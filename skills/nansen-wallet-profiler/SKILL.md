---
name: nansen-wallet-profiler
description: Wallet profiler — balance, PnL, labels, transactions, counterparties, related wallets, batch, trace, compare. Use when analysing a specific wallet address or comparing wallets.
metadata:
  openclaw:
    requires:
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

Browser login requests `nansen:api` for API-key-equivalent account API permissions; existing OAuth/MCP `nansen:read` semantics and separate wallet authorization are unchanged.

Before any research command or loop, require an explicitly selected API key or saved browser session. Run `nansen auth status` first. Its cached/unverified metadata does not prove credential validity or unlocked storage. Cached access-token expiry alone does not mean the session is unusable: the CLI normally renews a selected session automatically during an already-authorized research task, without another consent request or a separate account check. Stop on anonymous selection, invalid authentication state, blocked or uncertain renewal/cleanup, or an actual authentication failure, including rejected or expired refresh authority. Follow the CLI error guidance; use the free `nansen account` check when troubleshooting calls for it. Do not unset a failed key, erase a session or switch to anonymous access to retry.

Use `nansen login` for fresh browser approval when server admission and the supported platform cohort are enabled, or configure a conventional API key. `NANSEN_API_KEY` overrides the saved session. OpenClaw's optional `primaryEnv` mapping preserves configured API-key injection; it is not a required-key gate or proof of authentication. Normal credits and entitlements apply. Login does not purchase credits. Browser rollout acceptance is still pending.

API keys and browser sessions use the same automatic x402 payment behavior: a supported HTTP 402 challenge can spend funds from the configured wallet under existing wallet authorization, payment policy and spending limits. Each call, including calls in loops, can incur a payment. Authentication, authorization and session-renewal failures never trigger payment; login verification and `nansen account` never pay automatically. Anonymous x402 remains available as a separate paid workflow requiring explicit user intent and payment setup. Do not run this research workflow anonymously or switch to anonymous access after authentication fails.


# Wallet Profiler

All commands: `nansen research profiler <sub> [options]`

`--address` and `--chain` required for most commands.

## Balance & Identity

```bash
nansen research profiler balance --address <addr> --chain ethereum
nansen research profiler labels --address <addr> --chain ethereum
nansen research profiler search --query "Vitalik"
```

## PnL

```bash
nansen research profiler pnl --address <addr> --chain ethereum --days 30
nansen research profiler pnl-summary --address <addr> --chain ethereum
```

## Transactions & History

```bash
nansen research profiler transactions --address <addr> --chain ethereum --limit 20
nansen research profiler historical-balances --address <addr> --chain solana --days 30
```

## Relationships

```bash
nansen research profiler related-wallets --address <addr> --chain ethereum
nansen research profiler counterparties --address <addr> --chain ethereum --days 30

# Counterparties for up to 10 wallets in one call (max --days 90).
# Results are not aggregated — every row carries the wallet_address it belongs to.
# One ecosystem per request: EVM and Solana addresses cannot be mixed; `all` auto-detects it.
# --chain also takes any single chain the profiler serves, EVM or not: arbitrum, arc,
# avalanche, base, bitcoin, bnb (`bsc` is accepted too), ethereum, hyperevm, injective,
# iotaevm, linea, mantle, mantra, monad, near, optimism, plasma, polygon, robinhood, sei,
# solana, sonic, starknet, sui, ton, tron.
# Rows come back as contiguous per-wallet blocks ordered by wallet address, so a small page
# holds one wallet only — raise --limit and page with --page N to reach later wallets.
nansen research profiler counterparties-batch --addresses "0xabc,0xdef" --days 30 --limit 50
```

## Perps (no --chain)

```bash
nansen research profiler perp-positions --address <addr>
nansen research profiler perp-trades --address <addr> --days 7
```

## Batch, Trace & Compare

```bash
# Batch — profile multiple wallets at once
nansen research profiler batch \
  --addresses "0xabc,0xdef" --chain ethereum \
  --include labels,balance,pnl

# Trace — BFS multi-hop counterparty trace (makes N*width API calls)
nansen research profiler trace --address <addr> --chain ethereum --depth 2 --width 5

# Compare — shared counterparties and tokens between two wallets
nansen research profiler compare --addresses "0xabc,0xdef" --chain ethereum
```

## Flags

| Flag | Purpose |
|------|---------|
| `--address` | Wallet address (required) |
| `--chain` | Required except for perps and search |
| `--days` | Lookback period (default 30) |
| `--limit` | Number of results |
| `--addresses` | Comma-separated wallets for `batch`, `compare`, `counterparties-batch` |
| `--include` | Batch fields: `labels,balance,pnl` |
| `--depth` | Trace depth 1-5 (default 2) |
| `--width` | Trace width — keep low to save credits |
| `--fields` | Select specific fields |
| `--table` | Human-readable table output |
| `--format csv` | CSV export |

## Notes

- `pnl-summary` has no pagination support (returns aggregate stats, not a list).
- `perp-positions` has no pagination support.
- `labels` supports pagination — `--limit`/`--page` are honoured and the response is `{pagination: {page, per_page, is_last_page}, data[]: {label, category, kind[]}}`.
- `transactions` caps at per_page=100 (API limit).
- `trace` makes many API calls — use `--width` conservatively.
- `batch` accepts `--file <path>` with one address per line as alternative to `--addresses`.
