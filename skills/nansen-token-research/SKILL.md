---
name: nansen-token-research
description: Token deep dive — info, OHLCV, holders, flows, flow intelligence, who bought/sold, DEX trades, PnL, perp trades, perp positions, perp PnL leaderboard. Use when researching a specific token in depth.
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

Before any research command or loop, require an explicitly selected API key or saved browser session. Run `nansen auth status` first. Its cached/unverified metadata does not prove credential validity or unlocked storage. Cached access-token expiry alone does not mean the session is unusable: the CLI normally renews a selected session automatically during an already-authorized research task, without another consent request or a separate account check. Stop on anonymous selection, invalid authentication state, blocked or uncertain renewal/cleanup, or an actual authentication failure, including rejected or expired refresh authority. Follow the CLI error guidance; use the free `nansen account` check when troubleshooting calls for it. Do not unset a failed key, erase a session or switch to anonymous access to retry.

Use `nansen login` for fresh browser approval when server admission and the supported platform cohort are enabled, or configure a conventional API key. `NANSEN_API_KEY` overrides the saved session. OpenClaw's optional `primaryEnv` mapping preserves configured API-key injection; it is not a required-key gate or proof of authentication. Normal credits and entitlements apply. Login does not purchase credits. Browser rollout acceptance is still pending.

Anonymous x402 is a separate paid workflow: without a selected credential, the CLI can automatically spend funds from its configured wallet on a supported 402 challenge, once per call, including calls in loops. Do not run this research workflow anonymously. Anonymous payment requires separate explicit user intent and payment setup; it is never a fallback for failed authentication.


# Token Deep Dive

All commands: `nansen research token <sub> [options]`

`--chain` required for spot endpoints. Use `--token <address>` for token-specific endpoints.

## Info & Price

```bash
nansen research token info --token <addr> --chain solana
nansen research token ohlcv --token <addr> --chain solana --timeframe 1h
```

Timeframes: `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d`, `1w`, `1M`

## Holders

```bash
nansen research token holders --token <addr> --chain solana
nansen research token holders --token <addr> --chain solana --smart-money
```

## Flows

```bash
nansen research token flows --token <addr> --chain solana --days 7
nansen research token flow-intelligence --token <addr> --chain solana
nansen research token who-bought-sold --token <addr> --chain solana
```

`flow-intelligence` breaks down by label: whales, smart traders, exchanges, fresh wallets, public figures.

## DEX Trades

```bash
nansen research token dex-trades --token <addr> --chain solana --limit 20
```

## PnL

```bash
nansen research token pnl --token <addr> --chain solana --sort total_pnl_usd:desc
```

## Perps (no --chain)

```bash
nansen research token perp-trades --symbol ETH --days 7
nansen research token perp-positions --symbol BTC
nansen research token perp-pnl-leaderboard --symbol SOL
```

## Flags

| Flag | Purpose |
|------|---------|
| `--chain` | Required for spot endpoints (ethereum, solana, base, etc.) |
| `--token` | Token address (alias: `--token-address`) |
| `--symbol` | Token symbol for perp endpoints (e.g. BTC) |
| `--timeframe` | OHLCV interval |
| `--smart-money` | Filter to SM wallets only (holders) |
| `--days` | Lookback period (default 30) |
| `--sort` | Sort field:direction (e.g. `total_pnl_usd:desc`) |
| `--fields` | Select specific fields |
| `--table` | Human-readable table output |
| `--format csv` | CSV export |

## Notes

- Perp endpoints use `--symbol` (e.g. BTC), not `--token`.
- `holders --smart-money` returns UNSUPPORTED_FILTER for tokens without SM tracking.
- `flow-intelligence` may return all-zero flows for illiquid tokens.
