---
name: nansen-pm-screener
description: Screen Polymarket prediction markets — trending events, top markets by volume, and category overview. Use when finding what's active on Polymarket right now.
---

# Prediction Market Screener

No `--chain` flag — Polymarket runs on Polygon.

```bash
# Top events (groups of related markets)
nansen research prediction-market event-screener --sort-by volume_24hr --limit 20
# → event_title, market_count, total_volume, total_volume_24hr, total_liquidity, total_open_interest, tags

# Top individual markets
nansen research prediction-market market-screener --sort-by volume_24hr --limit 20
# → market_id, question, best_bid, best_ask, volume_24hr, liquidity, open_interest, unique_traders_24h

# Search for specific topic
nansen research prediction-market market-screener --query "bitcoin" --limit 10

# Resolved/closed markets
nansen research prediction-market market-screener --status closed --limit 10

# Category overview
nansen research prediction-market categories --pretty
```

Sort options: `volume_24hr`, `volume`, `volume_1wk`, `volume_1mo`, `liquidity`, `open_interest`, `unique_traders_24h`, `age_hours`
Default is active markets. Use `--status closed` for resolved.
`market_id` from screener is needed for all market-specific endpoints.
