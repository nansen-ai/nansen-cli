---
name: nansen-wallet-cluster
description: "Who else is in this wallet's cluster? Find related wallets (funders, co-signers, deployers) and profile the cluster for attribution and copy-trading research."
---

# Wallet Cluster

**Answers:** "Who are the wallets connected to this address, and are they smart money?"

```bash
ADDR=<address> CHAIN=ethereum

# Find related wallets (funders, deployers, multisig co-signers, etc.)
nansen research profiler related-wallets --address $ADDR --chain $CHAIN --limit 20
# → .data.data[]: {address, address_label, relation, block_timestamp}
# relation values: "First Funder", "Deployed by", "Multisig Signer of", "Funded"

# Profile each related wallet for identity and label
for each address in results:
nansen research profiler labels --address <related_addr> --chain $CHAIN
# → .data[]: {label, category, fullname}
# category: "smart_money", "fund", "social" (ENS), "others"

# Check PnL for high-value related wallets
nansen research profiler pnl-summary --address <related_addr> --chain $CHAIN --days 30
# → .data: {realized_pnl_usd, win_rate, traded_token_count, realized_pnl_percent}
```

Priority: focus on related wallets with "First Funder" or "Deployed by" relation — these indicate direct cluster membership, not just coincidental interaction.
Smart money labels in related wallets = cluster has institutional backing.
Multiple "Multisig Signer of" relations = shared governance or fund structure.
