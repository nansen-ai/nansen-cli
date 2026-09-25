---
name: nansen-holder-analysis
description: "Is this token held by quality wallets or retail noise? SM holder ratio, flow breakdown by label, and recent buyer quality."
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

# Holder Quality

**Answers:** "Is this token held by quality wallets or retail noise?"

```bash
TOKEN=<address> CHAIN=ethereum

nansen research token holders --token $TOKEN --chain $CHAIN --smart-money --limit 20
# → address, address_label, value_usd, ownership_percentage, balance_change_24h/7d/30d

nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → net_flow_usd and wallet_count per label: smart_trader, whale, exchange, fresh_wallets

nansen research token who-bought-sold --token $TOKEN --chain $CHAIN --limit 20
# → address, address_label, bought/sold_volume_usd, bought/sold_token_volume, trade_volume_usd
```

Red flag: high fresh_wallets flow + low SM holders. Green flag: Fund/Smart Trader labels in top 20.

Note: holders endpoint does not support native/wrapped tokens. Use a specific token contract address.
