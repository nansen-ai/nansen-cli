---
name: nansen-wallet-attribution
description: Cluster and attribute related wallets — funding chains, shared signers, CEX deposit patterns. Use when tracing wallet ownership, governance voters, or related address clusters.
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_API_KEY
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash
---

# Wallet Clustering & Attribution

**Chain detection:** Inspect the address format before running any command.
- Starts with `0x` → `--chain ethereum` (also works for base, arbitrum, optimism, polygon)
- Base58 (32–44 chars, no `0x`) → `--chain solana`

Run steps 1-3 on the seed. For every new address found, ask the human: **"Found `<addr>` via `<signal>` (`<label>`). Want me to query it?"** On confirm, re-run steps 1-3 on it. Keep expanding until no new addresses or confidence is Low.

```bash
# 1. Labels
nansen research profiler labels --address <addr> --chain <chain>

# 2. Related wallets (First Funder, Signer, Deployed via)
# Paginate until is_last_page: true — early pages may contain the key signal
nansen research profiler related-wallets --address <addr> --chain <chain>
nansen research profiler related-wallets --address <addr> --chain <chain> --page 2
# Note: Deployed Program relations are often NFT mints — deprioritize unless relation count > 1

# 3. Counterparties — try 90d, then 365d if empty
# Paginate to capture all counterparties — busy wallets often have is_last_page: false on page 1
nansen research profiler counterparties --address <addr> --chain <chain> --days 90
nansen research profiler counterparties --address <addr> --chain <chain> --days 90 --page 2
nansen research profiler counterparties --address <addr> --chain <chain> --days 365
# For EVM addresses — repeat on each L2
for chain in base arbitrum optimism polygon; do
  nansen research profiler counterparties --address <addr> --chain $chain --days 365
done

# 4. Batch profile the cluster
nansen research profiler batch --addresses "<a1>,<a2>" --chain <chain> --include labels,balance,pnl

# 5. Compare pairs
nansen research profiler compare --addresses "<a1>,<a2>" --chain <chain>

# 6. Coordinated balance movements
# Paginate if is_last_page: false — each page is a time window slice
nansen research profiler historical-balances --address <addr> --chain <chain> --days 90

# 7. Multi-hop trace — only if 2-3 inconclusive
nansen research profiler trace --address <addr> --chain <chain> --depth 2 --width 3
```

**Stop expanding when:** address is a known protocol/CEX · confidence is Low · already visited · cluster > 10 wallets.

## Attribution Rules

- CEX withdrawal → wallet owner (NOT the CEX)
- Smart account/DCA bot → end-user who funds it (NOT the protocol)
- Safe deployer ≠ owner — identical signer sets across Safes = same controller

| Confidence | Signals |
|------------|---------|
| **High** | First Funder / shared Safe signers / same CEX deposit address |
| **Medium** | Coordinated balance movements / related-wallets + label match |
| **Exclude** | ENS alone, single CEX withdrawal, single deployer |

**Output:** `address` · `owner` · `confidence (H/M/L)` · `signals` · `role`

**Notes:** Historical balances reveal past holdings on drained wallets — useful fingerprint. `trace` is credit-heavy; keep `--width 3` or lower.
