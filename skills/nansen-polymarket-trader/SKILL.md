---
name: nansen-polymarket-trader
description: "What is a Polymarket trader doing? Their recent trades, PnL by market, and current positions."
---

# Polymarket Trader

**Answers:** "What is this Polymarket trader betting on? Are they profitable?"

```bash
ADDR=<polymarket_address>

nansen research prediction-market trades-by-address --address $ADDR --limit 20
# → timestamp, market_question, event_title, taker_action, side, size, price, usdc_value

nansen research prediction-market pnl-by-address --address $ADDR --limit 20
# → market_id, question, event_title, side_held, net_buy_cost_usd, unrealized_value_usd, total_pnl_usd, market_resolved

nansen research prediction-market categories --limit 10
# → category, active_markets, total_volume_24hr, total_open_interest (for market context)
```

Look at PnL across resolved vs unresolved markets to gauge trader skill. Large positions in trending categories signal conviction.
