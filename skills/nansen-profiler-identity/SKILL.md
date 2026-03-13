---
name: nansen-profiler-identity
description: Identify a wallet — labels, balance, and name search. Use when you need to know who controls an address, what it holds, or look up an entity by name.
---

# Profiler — Identity & Balance

```bash
ADDR=<address> CHAIN=ethereum

# Who is this? Labels and categories
nansen research profiler labels --address $ADDR --chain $CHAIN
# → label, category ("smart_money", "fund", "social", "behavioral", "others"), fullname

# What do they hold?
nansen research profiler balance --address $ADDR --chain $CHAIN
# → token_symbol, token_name, token_amount, price_usd, value_usd

# Look up by name (no --chain needed)
nansen research profiler search --query "Vitalik"
# → address, name, labels, chain
```

`labels` has no pagination and always returns all labels — `--limit` is ignored.
For multi-chain balances, run `profiler balance` once per chain.
For batch profiling across many addresses, use `nansen-batch-wallet`.
