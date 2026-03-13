---
name: nansen-pm-depth
description: Deep-dive on a specific Polymarket market — price history (OHLCV), live orderbook, top position holders. Use when researching a specific market's price action or largest bettors.
---

# Prediction Market Depth

No `--chain` flag. `--market-id` is a numeric ID from the screener.

```bash
MID=<market_id>  # numeric from nansen-pm-screener

# Price history (OHLCV)
nansen research prediction-market ohlcv --market-id $MID --sort period_start:desc --limit 50
# → period_start, open, high, low, close, volume

# Live orderbook
nansen research prediction-market orderbook --market-id $MID
# → bids[], asks[] with price and size

# Largest position holders
nansen research prediction-market top-holders --market-id $MID --limit 10
# → address, side, position_size, avg_entry_price, current_price, unrealized_pnl_usd

# All open positions
nansen research prediction-market position-detail --market-id $MID --limit 20
# → address, side, size, avg_entry_price, unrealized_pnl_usd
```

Works on both active and resolved markets (ohlcv, positions, etc.).
`top-holders` addresses may have no trade history — use `nansen-pm-activity` to find active traders.
