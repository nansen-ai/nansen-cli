---
name: nansen-wallet-clustering
description: "Cluster and attribute related wallets — funding chains, shared signers, CEX deposit patterns. Use when tracing wallet ownership, comparing two wallets, finding wallet relationships, governance voters, or related address clusters."
metadata:
  openclaw:
    requires:
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---
## Authentication

Browser login requests `nansen:api` for API-key-equivalent account API permissions; existing OAuth/MCP `nansen:read` semantics and separate wallet authorization are unchanged.

Before any research command or loop, require an explicitly selected API key or saved browser session. Run `nansen auth status` first. Its cached/unverified metadata does not prove credential validity or unlocked storage. Cached access-token expiry alone does not mean the session is unusable: the CLI normally renews a selected session automatically during an already-authorized research task, without another consent request or a separate account check. Stop on anonymous selection, invalid authentication state, blocked or uncertain renewal/cleanup, or an actual authentication failure, including rejected or expired refresh authority. Follow the CLI error guidance; use the free `nansen account` check when troubleshooting calls for it. Do not unset a failed key, erase a session or switch to anonymous access to retry.

Use `nansen login` for fresh browser approval when server admission and the supported platform cohort are enabled, or configure a conventional API key. `NANSEN_API_KEY` overrides the saved session. OpenClaw's optional `primaryEnv` mapping preserves configured API-key injection; it is not a required-key gate or proof of authentication. Normal credits and entitlements apply. Login does not purchase credits. Browser rollout acceptance is still pending.

API keys and browser sessions use the same automatic x402 payment behavior: a supported HTTP 402 challenge can spend funds from the configured wallet under existing wallet authorization, payment policy and spending limits. Each call, including calls in loops, can incur a payment. Authentication, authorization and session-renewal failures never trigger payment; login verification and `nansen account` never pay automatically. Anonymous x402 remains available as a separate paid workflow requiring explicit user intent and payment setup. Do not run this research workflow anonymously or switch to anonymous access after authentication fails.


# Wallet Attribution

**Answers:** "Who controls this wallet? Are these wallets related?"

Chain: `0x` → `--chain ethereum` (also base, arbitrum, optimism, polygon). Base58 → `--chain solana`.

```bash
ADDR=<address> CHAIN=<ethereum|solana|base|...>  # detect from address format above
# 1. Identity
nansen research profiler labels --address $ADDR --chain $CHAIN
# 2. Related wallets (paginate with --page N)
nansen research profiler related-wallets --address $ADDR --chain $CHAIN
# 3. Counterparties (paginate with --page N; widen with --days 365 if empty)
nansen research profiler counterparties --address $ADDR --chain $CHAIN --days 90
# 3b. Once a cluster is confirmed: counterparties for up to 10 of its wallets in one call
#     (max --days 90; one ecosystem per request — EVM and Solana cannot be mixed). Rows are
#     contiguous per-wallet blocks ordered by wallet address: raise --limit and page with
#     --page N to reach later wallets.
nansen research profiler counterparties-batch --addresses "addr1,addr2" --chain $CHAIN --days 90 --limit 50
# 4. Batch profile cluster
nansen research profiler batch --addresses "addr1,addr2" --chain $CHAIN --include labels,balance,pnl
# 5. Compare pairs → shared_counterparties, shared_tokens, balances
nansen research profiler compare --addresses "addr1,addr2" --chain $CHAIN
# 6. Historical balances (fingerprint drained wallets)
nansen research profiler historical-balances --address $ADDR --chain $CHAIN --days 90
# 7. Multi-hop trace (credit-heavy — keep --width ≤3)
nansen research profiler trace --address $ADDR --chain $CHAIN --depth 2 --width 3
```

**Expansion:** Run steps 1-2 on seed. For each new address found, ask the human before querying. Reserve step 3 for seed only.
**Stop when:** known protocol/CEX · Low confidence · already visited · cluster > 10 wallets.
**Confidence:** High = first funder / shared Safe signers / same CEX deposit. Medium = coordinated movements / related-wallets + label match. Exclude = ENS only, single CEX withdrawal, single deployer.
Full attribution rules in REFERENCE.md.
