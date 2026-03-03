---
name: nansen-portfolio
description: Wallet DeFi portfolio — protocol positions, yield exposure, liquidity pools. Use when checking a wallet's DeFi activity, protocol breakdown, or yield farming positions.
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

# Portfolio

All commands: `nansen research portfolio <sub> [options]`

## DeFi Positions

```bash
# Full DeFi portfolio breakdown for a wallet
nansen research portfolio defi --wallet <addr>

# Human-readable table
nansen research portfolio defi --wallet <addr> --table

# Specific fields only
nansen research portfolio defi --wallet <addr> --fields protocol,position_type,value_usd
```

Returns protocol positions including: liquidity pools, lending/borrowing, staking, yield farming, and perpetual positions.

## Flags

| Flag | Purpose |
|------|---------|
| `--wallet` | Wallet address (required) |
| `--fields` | Select specific fields |
| `--table` | Human-readable table output |
| `--format csv` | CSV export |

## Notes

- Use with `nansen-profiler` for a complete wallet picture: portfolio + balance + PnL.
- For perp-specific positions, also check `nansen research profiler perp-positions --address <addr>`.
- For multi-chain coverage, run once per relevant chain.
