---
name: nansen-wallet-relationship
description: "Are these two wallets connected? Shared counterparties, common tokens, and cluster membership."
---

# Wallet Relationship

**Answers:** "Are these two wallets connected? Do they share tokens or counterparties?"

```bash
ADDR1=<address1> ADDR2=<address2> CHAIN=ethereum

nansen research profiler compare --addresses "$ADDR1,$ADDR2" --chain $CHAIN
# → shared_counterparties, shared_tokens, per-address balances

nansen research profiler counterparties --address $ADDR1 --chain $CHAIN --days 30
# → counterparty_address, counterparty_address_label, total_volume_usd, interaction_count

nansen research profiler counterparties --address $ADDR2 --chain $CHAIN --days 30

nansen research profiler related-wallets --address $ADDR1 --chain $CHAIN
# → address, address_label, relation (First Funder, Multisig Signer of), block_timestamp
```
