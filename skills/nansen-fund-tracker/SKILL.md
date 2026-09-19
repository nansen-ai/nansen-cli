---
name: nansen-fund-tracker
description: "What are crypto funds and VCs holding right now? Cross-chain fund portfolios and net accumulation signals."
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

Before any research command or loop, require an explicitly selected API key or saved browser session. Run `nansen auth status` first. Its cached/unverified metadata does not prove credential validity or unlocked storage. Cached access-token expiry alone does not mean the session is unusable: the CLI normally renews a selected session automatically during an already-authorized research task, without another consent request or a separate account check. Stop on anonymous selection, invalid authentication state, blocked or uncertain renewal/cleanup, or an actual authentication failure, including rejected or expired refresh authority. Follow the CLI error guidance; use the free `nansen account` check when troubleshooting calls for it. Do not unset a failed key, erase a session or switch to anonymous access to retry.

Use `nansen login` for fresh browser approval when server admission and the supported platform cohort are enabled, or configure a conventional API key. `NANSEN_API_KEY` overrides the saved session. OpenClaw's optional `primaryEnv` mapping preserves configured API-key injection; it is not a required-key gate or proof of authentication. Normal credits and entitlements apply. Login does not purchase credits. Browser rollout acceptance is still pending.

Anonymous x402 is a separate paid workflow: without a selected credential, the CLI can automatically spend funds from its configured wallet on a supported 402 challenge, once per call, including calls in loops. Do not run this research workflow anonymously. Anonymous payment requires separate explicit user intent and payment setup; it is never a fallback for failed authentication.

# Fund Watch

**Answers:** "What are crypto funds and VCs holding right now?"

```bash
nansen research smart-money holdings --chain ethereum --labels "Fund" --limit 20
# → token_symbol, value_usd, holders_count, balance_24h_percent_change, share_of_holdings_percent

nansen research smart-money holdings --chain solana --labels "Fund" --limit 20

nansen research smart-money netflow --chain ethereum --labels "Fund" --limit 10
# → token_symbol, net_flow_1h/24h/7d/30d_usd, market_cap_usd, trader_count

nansen research smart-money netflow --chain solana --labels "Fund" --limit 10
```

Cross-reference holdings with netflow to see directional conviction. Positive net_flow_24h = active accumulation.
