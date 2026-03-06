---
name: nansen-profiler-perps
description: Perp activity for a specific wallet — current positions and recent trades on Hyperliquid. Use when analysing a perp trader's book or checking leverage exposure.
---

# Profiler — Perp Positions & Trades

No `--chain` flag — Hyperliquid only.

```bash
ADDR=<address>

# Current open positions
nansen research profiler perp-positions --address $ADDR
# → asset_positions[], margin_summary_account_value_usd, margin_summary_total_margin_used_usd
# No pagination support — returns all positions.

# Recent perp trades
nansen research profiler perp-trades --address $ADDR --days 7 --limit 20
# → timestamp, token_symbol, side, action (Open/Close/Reduce), price, size, value_usd, closed_pnl, fee_usd
```

Cross-reference `perp-positions` (what's open now) with `perp-trades` (how they got there).
Check `perp leaderboard` for relative standing: `nansen research perp leaderboard --days 7 --limit 50`.
For market-level perp context, use `nansen-perp-scan`.
