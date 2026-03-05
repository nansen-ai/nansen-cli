---
name: nansen-wallet-cluster
description: "Who are the wallets connected to this address, and are they smart money?"
---
```bash
ADDR=<address> CHAIN=ethereum
nansen research profiler related-wallets --address $ADDR --chain $CHAIN --limit 20
# → .data.data[]: {address, address_label, relation, block_timestamp}
# relation: "First Funder", "Deployed by", "Multisig Signer of", "Funded"
nansen research profiler labels --address <related_addr> --chain $CHAIN  # per wallet
# → .data[]: {label, category, fullname}  category: "smart_money","fund","social","others"
nansen research profiler pnl-summary --address <related_addr> --chain $CHAIN --days 30
# → .data: {realized_pnl_usd, win_rate, traded_token_count, realized_pnl_percent}
```
Focus on "First Funder"/"Deployed by" — direct cluster membership, not coincidental interaction.
