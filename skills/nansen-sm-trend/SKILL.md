---
name: nansen-sm-trend
description: "How has smart money exposure to a token trended over time? Multi-period netflow analysis to determine if SM is accumulating, distributing, or just entered."
---

# Smart Money Trend

**Answers:** "Has SM been in this token for weeks, or did they just enter? Are they still buying?"

```bash
TOKEN=<address> CHAIN=ethereum

# Multi-period SM netflow for this token (1h / 24h / 7d / 30d)
nansen research smart-money netflow --chain $CHAIN --limit 100
# → filter by token_address or token_symbol from results
# → net_flow_1h_usd, net_flow_24h_usd, net_flow_7d_usd, net_flow_30d_usd, trader_count

# SM holder balance changes (position-level trend)
nansen research token holders --token $TOKEN --chain $CHAIN --smart-money --limit 20
# → address_label, value_usd, balance_change_24h, balance_change_7d, balance_change_30d

# Label-level flow breakdown
nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → smart_trader_net_flow_usd, whale_net_flow_usd, fund_net_flow_usd, fresh_wallets_net_flow_usd

# Earliest SM entry (find first labeled buy in trade history)
nansen research token dex-trades --token $TOKEN --chain $CHAIN --limit 50
# → block_timestamp, action, trader_address_label — find oldest SM-labeled BUY
```

Interpret netflow pattern:
- 1h/24h positive + 7d/30d positive = sustained accumulation, SM has been here a while
- 24h positive + 7d negative = fresh entry, SM just turned bullish (could be early or reactive)
- 24h negative + 7d positive = SM starting to reduce, watch for exit
- All timeframes negative = active distribution

Note: smart-money netflow returns all tokens; filter client-side by token_address or token_symbol.
