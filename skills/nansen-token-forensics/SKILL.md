---
name: nansen-token-forensics
description: "Where is this token moving and why? Large transfers, flow trends over time, and breakdown by wallet label."
---

# Token Forensics

**Answers:** "Where is this token moving? Who is sending it and where?"

```bash
TOKEN=<address> CHAIN=ethereum

nansen research token transfers --token $TOKEN --chain $CHAIN --days 7 --limit 20
# → block_timestamp, from_address, to_address, from_address_label, to_address_label, transfer_amount, transfer_value_usd

nansen research token flows --token $TOKEN --chain $CHAIN --days 7 --limit 20
# → date, price_usd, token_amount, value_usd, holders_count, total_inflows_count, total_outflows_count

nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → net_flow_usd per label: smart_trader, whale, exchange, fresh_wallets, public_figure
```

Rising exchange_net_flow + large transfers to exchange addresses = potential sell pressure. Fresh wallet inflows may signal new interest or wash trading.
