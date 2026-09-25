---
name: nansen-smart-money-trend
description: "Has SM been in this token for weeks, or did they just enter? Are they still buying?"
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

```bash
TOKEN=<address> CHAIN=ethereum
nansen research smart-money netflow --chain $CHAIN --limit 200
# → filter by token_address; net_flow_1h_usd, net_flow_24h_usd, net_flow_7d_usd, net_flow_30d_usd
nansen research token holders --token $TOKEN --chain $CHAIN --smart-money --limit 20
# → address_label, value_usd, balance_change_24h, balance_change_7d, balance_change_30d
nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → smart_trader_net_flow_usd, whale_net_flow_usd, fund_net_flow_usd, fresh_wallets_net_flow_usd
nansen research token dex-trades --token $TOKEN --chain $CHAIN --limit 50
# → block_timestamp, action, trader_address_label — find oldest SM-labeled BUY
```
1h/24h+ & 7d/30d+ = sustained accumulation. 24h+ & 7d− = fresh entry.
24h− & 7d+ = reducing. All negative = distribution.
