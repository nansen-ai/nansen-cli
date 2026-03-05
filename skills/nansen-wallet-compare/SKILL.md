---
name: nansen-wallet-compare
description: "Is wallet B copying wallet A? Are these two wallets from the same entity?"
---
```bash
ADDR_A=<address_1> ADDR_B=<address_2> CHAIN=ethereum
nansen research profiler labels --address $ADDR_A --chain $CHAIN
nansen research profiler labels --address $ADDR_B --chain $CHAIN
# → .data[]: {label, category, fullname}
nansen research profiler pnl-summary --address $ADDR_A --chain $CHAIN --days 30
nansen research profiler pnl-summary --address $ADDR_B --chain $CHAIN --days 30
# → .data: {realized_pnl_usd, win_rate, traded_token_count, top5_tokens}
nansen research profiler balance --address $ADDR_A --chain $CHAIN
nansen research profiler balance --address $ADDR_B --chain $CHAIN
# → .data.data[]: {token_symbol, token_amount, value_usd} — cross-ref shared positions
nansen research profiler counterparties --address $ADDR_A --chain $CHAIN --days 30
nansen research profiler counterparties --address $ADDR_B --chain $CHAIN --days 30
# → .data.data[]: {counterparty_address, counterparty_address_label, interaction_count}
```
Copy-trading: shared top5_tokens + similar timing. Same entity: shared counterparties + ENS overlap.
