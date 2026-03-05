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

Run steps 1-3 in order per seed address. Repeat for each high-confidence related address found.

## Step-by-Step Workflow

```bash
# 1. Labels — entity clues (corroborating only, not proof)
nansen research profiler labels --address <addr> --chain ethereum

# 2. Direct relationships — flag: First Funder, Signer, Deployed via
nansen research profiler related-wallets --address <addr> --chain ethereum

# 3. Counterparties — skip CEX hops; flag shared CEX deposit addresses across wallets
nansen research profiler counterparties --address <addr> --chain ethereum --days 90

# 4. Batch profile the candidate cluster
nansen research profiler batch \
  --addresses "<a1>,<a2>,<a3>" --chain ethereum \
  --include labels,balance,pnl

# 5. Compare pairs for shared counterparties + tokens
nansen research profiler compare --addresses "<a1>,<a2>" --chain ethereum

# 6. Confirm with coordinated balance movements
nansen research profiler historical-balances --address <addr> --chain ethereum --days 90

# 7. Multi-hop trace — only if steps 2-3 inconclusive; keep width low
nansen research profiler trace --address <addr> --chain ethereum --depth 2 --width 3
```

## Attribution Rules

Core test: "Who would receive assets if this wallet withdrew everything?"

- CEX withdrawal → wallet owner (NOT the CEX)
- Smart account/DCA bot → end-user who funds it (NOT the protocol)
- Safe deployer ≠ owner — identical signer sets across Safes = same controller
- Trace through intermediary wallets to ultimate source

## Confidence Levels

| Level | Signals |
|-------|---------|
| **High** | First Funder / shared Safe signers / same CEX deposit address |
| **Medium** | Coordinated balance movements / related-wallets + label match |
| **Exclude** | ENS alone, single CEX withdrawal, single deployer |

## Output Format

Per address: `address` · `owner` · `confidence (H/M/L)` · `signals` · `role`

## Notes

- Steps 1-3 are the core loop — repeat for every new candidate address surfaced.
- `trace` makes many API calls — use `--width 3` or lower to control credit burn.
- CEX deposit address matches across wallets are strong High-confidence signals.
- `compare` is most useful after batch profiling narrows the candidate cluster.
