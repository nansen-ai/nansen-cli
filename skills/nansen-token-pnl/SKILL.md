---
name: nansen-token-pnl
description: "Who is making or losing money on this token? Spot PnL leaderboard, perp PnL leaderboard, and price chart for context."
---

# Token PnL

**Answers:** "Who is making the most money trading this token?"

```bash
TOKEN=<address> CHAIN=solana SYMBOL=JUP

nansen research token pnl --token $TOKEN --chain $CHAIN --days 30 --limit 20
# → trader_address, trader_address_label, pnl_usd_realised, pnl_usd_unrealised, roi_percent_total, holding_amount, nof_trades

nansen research token perp-pnl-leaderboard --symbol $SYMBOL --days 30 --limit 20
# → trader_address, trader_address_label, pnl_usd_realised, pnl_usd_unrealised, position_value_usd, roi_percent_total, nof_trades

nansen research token ohlcv --token $TOKEN --chain $CHAIN --timeframe 1d
# → interval_start, open, high, low, close, volume_usd, market_cap
```

Compare spot vs perp leaderboards: traders appearing in both with positive PnL have strong conviction and skill.
