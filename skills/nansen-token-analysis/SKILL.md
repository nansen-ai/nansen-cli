---
name: nansen-token-analysis
description: "What is happening with this token right now? Price, Nansen score, smart money flows, top holders, and recent DEX trades."
---

# Token Analysis

**Answers:** "What is happening with this token right now?"

```bash
TOKEN=<address> CHAIN=solana

nansen research token info --token $TOKEN --chain $CHAIN
# → name, symbol, price, market_cap, token_details, spot_metrics

nansen research token indicators --token $TOKEN --chain $CHAIN
# → risk_indicators, reward_indicators (each with score, signal, signal_percentile)

nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → net_flow_usd and wallet_count per label: smart_trader, whale, exchange, fresh_wallets, public_figure

nansen research token holders --token $TOKEN --chain $CHAIN --smart-money --limit 20
# → address, address_label, value_usd, ownership_percentage, balance_change_24h/7d/30d

nansen research token dex-trades --token $TOKEN --chain $CHAIN --limit 10
# → block_timestamp, action (BUY/SELL), trader_address, token_amount, estimated_value_usd
```

Note: holders and dex-trades do not support native/wrapped tokens (e.g. SOL, ETH). Use a specific token address.
