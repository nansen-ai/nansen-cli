---
name: nansen-prediction-markets
description: "What is happening on Polymarket? Trending events, top markets by volume, and smart money positions on prediction markets."
---

# Prediction Markets

**Answers:** "What is happening on prediction markets right now?"

```bash
nansen research prediction-market event-screener --limit 20
# → event_title, market_count, total_volume, total_volume_24hr, total_liquidity, total_open_interest, tags

nansen research prediction-market market-screener --limit 20
# → market_id, question, best_bid, best_ask, volume_24hr, liquidity, open_interest, unique_traders_24h

# Deep-dive on a specific market (use market_id from screener)
MID=<market_id>
nansen research prediction-market top-holders --market-id $MID --limit 20
# → address, side, position_size, avg_entry_price, current_price, unrealized_pnl_usd

nansen research prediction-market trades-by-market --market-id $MID --limit 20
# → timestamp, buyer, seller, taker_action, side, size, price, usdc_value
```

Use `--sort-by volume_24hr` on screeners for the most active markets.
