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

This is a recursive BFS process. Start from the seed address. Every new address surfaced in steps 1-3 becomes a new seed — run steps 1-3 on it too. Keep expanding until no new addresses are found or confidence drops to Low.

## Step-by-Step Workflow

```bash
# 1. Labels — entity clues (corroborating only, not proof)
nansen research profiler labels --address <addr> --chain ethereum

# 2. Direct relationships — flag: First Funder, Signer, Deployed via
#    ⚠️  Every address returned here is a new seed — run steps 1-3 on it
nansen research profiler related-wallets --address <addr> --chain ethereum

# 3. Counterparties — skip CEX hops; flag shared CEX deposit addresses across wallets
#    ⚠️  Non-CEX counterparties with significant volume are new seeds — run steps 1-3 on them
nansen research profiler counterparties --address <addr> --chain ethereum --days 90

# If 90d is empty, widen the window
nansen research profiler counterparties --address <addr> --chain ethereum --days 365

# Also check other chains for the same address — the cluster may span L2s
for chain in base arbitrum optimism polygon; do
  nansen research profiler counterparties --address <addr> --chain $chain --days 365
done

# 4. Batch profile the full candidate cluster
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

## Recursive Expansion Rule

```
seed → steps 1-3 → new addresses found?
  YES → run steps 1-3 on each new address → add to cluster if High/Medium confidence
  NO  → stop expanding, proceed to steps 4-7 to profile the full cluster
```

Stop expanding when:
- New address is a known protocol/contract (Aave, Uniswap, CEX, etc.)
- Confidence for the link is Low
- You've already visited the address
- Cluster exceeds 10 addresses (use `trace` instead)

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

- Steps 1-3 are the recursive core — always re-run them on every new address found.
- Old/inactive wallets may return empty counterparties at 90d — always retry at 365d.
- Check multiple chains — clusters often span Ethereum + L2s even when Ethereum data is thin.
- `trace` makes many API calls — use `--width 3` or lower to control credit burn.
- CEX deposit address matches across wallets are strong High-confidence signals.
- `compare` is most useful after batch profiling narrows the candidate cluster.
- Historical balances reveal past token holdings even on drained wallets — useful behavioral fingerprint when counterparty data is sparse.
