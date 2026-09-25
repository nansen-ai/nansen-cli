---
name: nansen-smart-money-alpha
description: "What tokens is smart money accumulating before they pump? Token screener with SM filter cross-referenced against netflow."
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

Anonymous x402 is a separate paid workflow: without a selected credential, the CLI can automatically spend funds from its configured wallet on a supported 402 challenge, once per call, including calls in loops. Do not run this research workflow anonymously. Anonymous payment requires separate explicit user intent and payment setup; it is never a fallback for failed authentication.


# Alpha Discovery

**Answers:** "What tokens is smart money accumulating before they pump?"

```bash
CHAIN=solana

nansen research token screener --chain $CHAIN --timeframe 24h --smart-money --limit 20
# → token_symbol, price_usd, price_change, volume, buy_volume, market_cap_usd, fdv, liquidity, token_age_days

nansen research smart-money netflow --chain $CHAIN --labels "Smart Trader" --limit 10
# → token_symbol, net_flow_1h/24h/7d/30d_usd, trader_count

# Confirm SM flow on a specific token from screener results
TOKEN=<address_from_screener>
nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → net_flow_usd per label: smart_trader, whale, exchange, fresh_wallets
```

Cross-reference screener results with positive netflow to find early accumulation.

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
