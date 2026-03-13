---
name: nansen-profiler-history
description: Wallet transaction history, counterparties, and related wallets. Use when tracing activity, finding who a wallet transacts with, or surfacing linked addresses.
---

# Profiler — Transaction History & Relationships

```bash
ADDR=<address> CHAIN=ethereum

# On-chain transactions
nansen research profiler transactions --address $ADDR --chain $CHAIN --limit 20
# → block_timestamp, tx_hash, action, counterparty_address, value_usd
# API caps at per_page=100

# Who does this wallet trade/interact with?
nansen research profiler counterparties --address $ADDR --chain $CHAIN --days 90
# → counterparty_address, counterparty_address_label, interaction_count, total_volume_usd
# Repeat with --page N+1 until is_last_page: true. If empty, retry --days 365.

# Addresses funded by or linked to this wallet
nansen research profiler related-wallets --address $ADDR --chain $CHAIN
# → address, address_label, relation, block_timestamp, chain
# Repeat with --page N+1 until is_last_page: true
```

For deep cluster analysis (multi-hop tracing, batch profiling, wallet comparison), use `nansen-wallet-attribution`.
`counterparties` is EVM-only — for Solana wallet relationships, use `related-wallets`.
