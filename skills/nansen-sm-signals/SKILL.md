---
name: nansen-sm-signals
description: "What is smart money buying or selling right now? Net accumulation signals, live DEX trades, and current SM portfolios."
---

# Smart Money Signals

**Answers:** "What is smart money buying or selling right now?"

```bash
CHAIN=solana

nansen research smart-money netflow --chain $CHAIN --labels "Smart Trader" --limit 10
# → token_symbol, net_flow_1h/24h/7d/30d_usd, market_cap_usd, trader_count, token_age_days

nansen research smart-money dex-trades --chain $CHAIN --labels "Smart Trader" --limit 20
# → block_timestamp, trader_address_label, token_bought/sold_symbol, token_bought/sold_amount, trade_value_usd

nansen research smart-money holdings --chain $CHAIN --labels "Smart Trader" --limit 10
# → token_symbol, value_usd, holders_count, balance_24h_percent_change, share_of_holdings_percent
```

Labels: `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `Fund`, `Smart HL Perps Trader`
