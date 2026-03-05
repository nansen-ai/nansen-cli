---
name: nansen-wallet-compare
description: "Is wallet B copying wallet A? Are these two wallets from the same entity? Uses profiler compare for shared counterparties and tokens, plus labels and PnL for identity."
---
```bash
ADDR_A=<address_1> ADDR_B=<address_2> CHAIN=ethereum
nansen research profiler compare --addresses "$ADDR_A,$ADDR_B" --chain $CHAIN --days 30
# → .data: {shared_counterparties[], shared_tokens[], balances[]}
nansen research profiler labels --address $ADDR_A --chain $CHAIN
nansen research profiler labels --address $ADDR_B --chain $CHAIN
# → .data[]: {label, category ("smart_money","fund","social","others"), fullname}
nansen research profiler pnl-summary --address $ADDR_A --chain $CHAIN --days 30
nansen research profiler pnl-summary --address $ADDR_B --chain $CHAIN --days 30
# → .data: {realized_pnl_usd, win_rate, traded_token_count, top5_tokens}
```
shared_counterparties + shared_tokens from compare = copy-trading or same entity signal.
Same entity: shared counterparties AND overlapping labels. Copy-trading: shared top5_tokens + different labels.
