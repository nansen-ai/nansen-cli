---
name: nansen-wallet-compare
description: "Compare two wallets side by side — identity, performance, and holdings overlap. Use for copy-trading detection, cluster attribution, or fund vs trader comparison."
---

# Wallet Compare

**Answers:** "Is wallet B copying wallet A? Are these two wallets from the same entity?"

```bash
ADDR_A=<address_1> ADDR_B=<address_2> CHAIN=ethereum

# Identity comparison
nansen research profiler labels --address $ADDR_A --chain $CHAIN
nansen research profiler labels --address $ADDR_B --chain $CHAIN
# → .data[]: {label, category, fullname}
# Compare: same fund? same ENS cluster? overlapping labels?

# Performance comparison (30-day)
nansen research profiler pnl-summary --address $ADDR_A --chain $CHAIN --days 30
nansen research profiler pnl-summary --address $ADDR_B --chain $CHAIN --days 30
# → .data: {realized_pnl_usd, win_rate, traded_token_count, realized_pnl_percent, top5_tokens}

# Holdings overlap
nansen research profiler balance --address $ADDR_A --chain $CHAIN
nansen research profiler balance --address $ADDR_B --chain $CHAIN
# → .data.data[]: {token_symbol, token_amount, value_usd}
# Cross-reference token_symbol lists to find shared positions

# Transaction overlap (shared counterparties)
nansen research profiler counterparties --address $ADDR_A --chain $CHAIN --days 30
nansen research profiler counterparties --address $ADDR_B --chain $CHAIN --days 30
# → .data.data[]: {counterparty_address, counterparty_address_label (array), interaction_count, total_volume_usd}
# Shared counterparties = likely coordinated or copy-trading
```

Copy-trading signal: B holds same top5_tokens as A, with similar entry timing from dex-trades.
Same entity signal: shared counterparties + overlapping ENS labels + First Funder relation.
