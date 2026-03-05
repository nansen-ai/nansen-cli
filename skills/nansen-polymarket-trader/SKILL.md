---
name: nansen-polymarket-trader
description: "What is a Polymarket trader betting on? Their recent trades, PnL by market, and current positions."
---

# Polymarket Trader

**Answers:** "What is this Polymarket trader betting on? Are they profitable?"

**Finding an active trader address:** Source from `trades-by-market` (guarantees trade history) rather than `top-holders` (position holders may have no recorded trades):

```bash
# Step 1: find a market and get active traders from it
nansen research prediction-market market-screener --limit 10
# → pick a market_id from results

nansen research prediction-market trades-by-market --market-id <market_id> --limit 5
# → seller/buyer addresses with confirmed trade history — use one as ADDR below
```

```bash
ADDR=<polymarket_address>

nansen research prediction-market trades-by-address --address $ADDR --limit 20
# → timestamp, market_question, event_title, taker_action, side, size, price, usdc_value

nansen research prediction-market pnl-by-address --address $ADDR --limit 20
# → question, event_title, side_held, net_buy_cost_usd, unrealized_value_usd, total_pnl_usd, market_resolved

nansen research prediction-market categories --limit 10
# → category, active_markets, total_volume_24hr, total_open_interest (market context)
```

Note: addresses sourced from `top-holders` may return empty trade history — use `trades-by-market` to find addresses with confirmed activity.

Look at PnL across resolved vs unresolved markets to gauge trader skill. Large positions in trending categories signal conviction.
