---
name: nansen-whale-tracker
description: "What is a known whale doing across spot and perps? Identity, holdings, recent trades, open perp positions, counterparties."
---

# Whale Tracker

**Answers:** "What is a known whale doing across spot + perps?"

```bash
ADDR=<whale_address> CHAIN=ethereum

nansen research profiler labels --address $ADDR --chain $CHAIN
# → label, category (identity, SM labels, ENS names)

nansen research profiler balance --address $ADDR --chain $CHAIN
# → token_symbol, token_amount, value_usd, price_usd per holding

nansen research profiler transactions --address $ADDR --chain $CHAIN --limit 20
# → block_timestamp, method, tokens_sent, tokens_received, volume_usd

nansen research profiler perp-positions --address $ADDR
# → asset_positions, margin_summary_account_value_usd, margin_summary_total_margin_used_usd

nansen research profiler counterparties --address $ADDR --chain $CHAIN --days 7
# → counterparty_address, counterparty_address_label, total_volume_usd, interaction_count
```

perp-positions returns Hyperliquid data — returns empty if the wallet has no open perps.
