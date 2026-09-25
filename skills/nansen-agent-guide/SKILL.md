---
name: nansen-agent-guide
description: Routing guide -- when to use `nansen agent` (AI research) vs direct CLI data commands. Use when deciding how to answer a user's research question with Nansen tools.
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



# Agent vs CLI Routing

Public agent fast/expert and direct API commands accept the selected nansen:api browser session or conventional API key under the same account permissions.

| Need a... | Use |
|-----------|-----|
| **take** (analysis, interpretation) | `nansen agent` |
| **table** (raw data, specific metrics) | Direct CLI commands |
| **report** (both) | Agent for narrative + CLI for data |

## Use `nansen agent` when

- Question requires interpretation or synthesis across multiple data sources
- Open-ended research: "analyse this wallet", "what's happening with ETH smart money?"

```bash
nansen agent "What are top smart money tokens on Solana today and why?"
nansen agent "Analyse wallet 0x123... -- is this a smart trader?"
nansen agent "..." --expert   # deeper analysis, 750 credits
```

Cost: 200 credits (fast) / 750 credits (expert)

## Use direct CLI commands when

- You need specific structured data -- prices, volumes, holders, flows
- Deterministic question: "top 10 tokens by netflow on ethereum"
- Piping output or building a data table

```bash
nansen research token screener --chain ethereum --smart-money --limit 10
nansen research smart-money netflow --chain solana
nansen research profiler balance --address 0x123... --chain ethereum
```

Cost: 5-50 credits per call

## Anti-patterns

- Don't use `nansen agent` for simple data fetches -- 40x more expensive
- Don't use raw CLI for open-ended analysis -- returns data, not interpretation
- Don't chain 3+ agent calls -- get raw data via CLI, call agent once for synthesis

## Browser session scope

Plain `nansen login` requests fresh browser approval; `--no-browser` prints the link/code for remote use. NANSEN_API_KEY overrides the single saved credential. Use `nansen auth status` for offline cached/unverified selection details and `nansen account` for a free live check. Explicit `login --human` or `login --api-key` retains legacy key setup. Selected browser sessions renew automatically; uncertain renewal requires fresh login without replay or fallback to another account/payment.

Browser nansen:api grants have API-key-equivalent account permissions, subject to enabled admission and the same endpoint restrictions. Internal service identity and wallet signing are not granted. Browser sessions cannot authorize wallet signing or be exported as MCP keys. Normal-release acceptance and a published cohort remain pending.
