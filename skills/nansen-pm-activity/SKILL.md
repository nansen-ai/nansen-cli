---
name: nansen-pm-activity
description: Polymarket trade history and PnL — trades by market, trades by address, and PnL leaderboards. Use when finding active traders, tracking bets, or evaluating a bettor's track record.
---

# Prediction Market Activity & PnL

No `--chain` flag. All addresses are Polygon (EVM).

```bash
MID=<market_id>
ADDR=<polymarket_address>

# Trades for a market — also best way to find active trader addresses
nansen research prediction-market trades-by-market --market-id $MID --limit 20
# → timestamp, buyer, seller, taker_action, side, size, price, usdc_value

# Trades for a specific address
nansen research prediction-market trades-by-address --address $ADDR --limit 20
# → timestamp, market_question, event_title, taker_action, side, size, price, usdc_value

# PnL leaderboard for a market
nansen research prediction-market pnl-by-market --market-id $MID --limit 20
# → address, total_pnl_usd, roi_percent, trades_count

# Full PnL breakdown for a trader
nansen research prediction-market pnl-by-address --address $ADDR --limit 20
# → question, event_title, side_held, net_buy_cost_usd, unrealized_value_usd, total_pnl_usd, market_resolved
```

Use `trades-by-market` to source active trader addresses (not `top-holders` — those may have no trade history).
Resolved `pnl-by-address` entries show realised skill; unresolved show live exposure.
