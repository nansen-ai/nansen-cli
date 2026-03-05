---
name: nansen-wallet-network
description: "Who does this wallet transact with? Direct counterparties, entity clusters, and multi-hop BFS network trace."
---

# Wallet Network

**Answers:** "Who does this wallet transact with? What's their network?"

```bash
ADDR=<address> CHAIN=ethereum

nansen research profiler counterparties --address $ADDR --chain $CHAIN --days 30
# → counterparty_address, counterparty_address_label, interaction_count, total_volume_usd, volume_in/out_usd

nansen research profiler related-wallets --address $ADDR --chain $CHAIN
# → address, address_label, relation (First Funder, Multisig Signer of), block_timestamp, chain

nansen research profiler trace --address $ADDR --chain $CHAIN --depth 2 --width 3
# → root, nodes (address list), edges (from→to with volume), stats (nodes_visited, edges_found)
```

Warning: trace makes depth x width API calls. Keep --width <=3 to avoid excessive credit use.
