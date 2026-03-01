---
name: nansen-perp
description: Perpetuals analytics on Hyperliquid — screener, leaderboard, positions. Use when checking perp markets, funding rates, or top perp traders.
allowed-tools: Bash
---

# Perps (Hyperliquid)

No `--chain` flag needed — Hyperliquid only.

## Screener

```bash
# Top perp markets by volume
nansen research perp screener --sort volume:desc --limit 20

# Agent pattern — JSON output
nansen research perp screener --sort open_interest:desc --limit 10 --output json \
  --fields token_symbol,volume,open_interest,funding
```

## Leaderboard

```bash
# Top perp traders over 7 days
nansen research perp leaderboard --days 7 --limit 20
```

## Flags

| Flag | Purpose |
|------|---------|
| `--sort field:dir` | Sort (e.g. `volume:desc`) |
| `--limit` | Number of results |
| `--days` | Lookback period |
| `--output json` | JSON output |
| `--fields a,b` | Select fields |

## Exit Codes

`0`=Success, `1`=Error, `2`=No data, `3`=Auth error
