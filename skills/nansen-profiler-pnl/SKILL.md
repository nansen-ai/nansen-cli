---
name: nansen-profiler-pnl
description: Wallet PnL — realised/unrealised profit breakdown per token, summary stats, and historical balance snapshots. Use when evaluating a trader's track record or portfolio evolution.
---

# Profiler — PnL & History

```bash
ADDR=<address> CHAIN=ethereum

# PnL per token (30d default)
nansen research profiler pnl --address $ADDR --chain $CHAIN --days 30 --limit 20
# → token_symbol, pnl_usd_realised, roi_percent_realised, bought_usd, sold_usd, holding_usd, nof_buys, nof_sells

# Aggregate summary
nansen research profiler pnl-summary --address $ADDR --chain $CHAIN
# → total_pnl_usd_realised, total_roi_percent, total_trades (no pagination)

# Historical balances — portfolio over time
nansen research profiler historical-balances --address $ADDR --chain $CHAIN --days 30 --limit 20
# → block_timestamp, token_symbol, token_amount, value_usd
```

`pnl-summary` returns aggregate stats — no per-token breakdown, no pagination.
`historical-balances` reveals past holdings even on drained wallets — useful for fingerprinting.
Combine with `profiler pnl` for trade frequency context.
