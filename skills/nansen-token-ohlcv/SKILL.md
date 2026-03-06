---
name: nansen-token-ohlcv
description: Fetch OHLCV price candles for a token. Use when charting price history or comparing price action to on-chain flow.
---

# Token OHLCV

```bash
TOKEN=<address> CHAIN=solana

nansen research token ohlcv --token $TOKEN --chain $CHAIN --timeframe 1h
# → interval_start, open, high, low, close, volume_usd, market_cap

# Daily candles, 30d window
nansen research token ohlcv --token $TOKEN --chain $CHAIN --timeframe 1d
```

Timeframes: `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d`, `1w`, `1M`

Pair with `nansen research token flow-intelligence` to see if SM flow aligns with price action.
Pair with `nansen research token pnl` (or `nansen-token-pnl` skill) to identify when top traders entered.
