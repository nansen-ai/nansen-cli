---
name: nansen-points
description: Points program leaderboards — track top earners across protocol incentive programs. Use when checking points rankings, airdrop farming leaderboards, or protocol incentive standings.
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_API_KEY
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash
---

# Points Leaderboard

All commands: `nansen research points <sub> [options]`

## Leaderboard

```bash
# Top points earners
nansen research points leaderboard --limit 20

# Human-readable table
nansen research points leaderboard --limit 20 --table

# Sort by specific metric
nansen research points leaderboard --sort points:desc --limit 50

# Export top earners
nansen research points leaderboard --limit 100 --format csv
```

## Flags

| Flag | Purpose |
|------|---------|
| `--limit` | Number of results |
| `--sort` | Sort field:direction |
| `--fields` | Select specific fields |
| `--table` | Human-readable table output |
| `--format csv` | CSV export |

## Notes

- Use alongside `nansen-profiler` to investigate specific wallets from the leaderboard.
- Combine with `nansen-smart-money` to check if top points earners are also tracked as smart money.
