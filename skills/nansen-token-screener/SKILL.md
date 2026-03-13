---
name: nansen-token-screener
description: Screen trending tokens by volume, price change, or smart money activity. Use when finding which tokens are moving right now or filtering for SM-backed tokens.
---

# Token Screener

```bash
# Top tokens by volume (24h)
nansen research token screener --chain solana --timeframe 24h --limit 20
# → token_symbol, price_usd, price_change, volume, buy_volume, market_cap_usd, fdv, liquidity, token_age_days

# Filter to smart money only
nansen research token screener --chain solana --timeframe 24h --smart-money --limit 20

# Search within results
nansen research token screener --chain solana --search "bonk"
```

Timeframes: `5m`, `10m`, `1h`, `6h`, `24h`, `7d`, `30d`
Chains: `ethereum`, `solana`, `base`, `bnb`, `arbitrum`, `optimism`, `polygon`

Use `--smart-money` to see only tokens with SM wallet activity.
Use 24h for momentum, 7d for trend, 30d for sustained accumulation.
