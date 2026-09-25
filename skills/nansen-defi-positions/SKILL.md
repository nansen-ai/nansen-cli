---
name: nansen-defi-positions
description: "What DeFi positions does a wallet hold? Protocol-by-protocol breakdown of assets, debts, and rewards across chains."
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

Nansen account API calls accept a selected `nansen:api` browser session or conventional API key with the same permissions. `NANSEN_API_KEY` takes precedence; optional `primaryEnv` preserves configured-key injection. Run `nansen auth status` for offline selection. Cached access expiry alone permits automatic renewal during an authorized task. Stop on anonymous selection, invalid state, blocked/uncertain renewal or actual auth failure; never drop a credential or fall back to anonymous x402 payment. Browser login does not grant wallet signing, privileged service identity or a persistent MCP integration key. Preserve all confirmation, signing, sanctions and geographic checks below. Browser rollout acceptance is still pending.



# DeFi Exposure

**Answers:** "What DeFi positions does this wallet have across protocols?"

```bash
ADDR=<address>

nansen research portfolio defi --wallet $ADDR
# → protocol_name, chain, total_value_usd, total_assets_usd, total_debts_usd, total_rewards_usd, tokens

nansen research profiler balance --address $ADDR --chain ethereum
# → token_symbol, token_name, token_amount, value_usd per holding

nansen research profiler balance --address $ADDR --chain base
```

Combine DeFi positions (lending, LPs, staking) with spot balances for a complete picture of on-chain exposure.

Note: portfolio defi may return empty for wallets with no tracked DeFi positions.
