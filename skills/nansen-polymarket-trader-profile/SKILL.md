---
name: nansen-polymarket-trader-profile
description: "What is a Polymarket trader betting on? Trades by address, PnL breakdown, and market context. Use when analysing a specific Polymarket wallet."
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

# Polymarket Wallet Activity

**Answers:** "What is this Polymarket trader betting on? Are they profitable?"

**Finding an active trader address:** Source from `trades-by-market` (guarantees trade history) rather than `top-holders` (position holders may have no recorded trades):

```bash
# Step 1: find active traders from a market
nansen research pm trades-by-market --market-id <market_id> --limit 5
# → seller/buyer addresses with confirmed trade history — use one as ADDR below
```

```bash
ADDR=<polymarket_address>

nansen research pm trades-by-address --address $ADDR --limit 20
# → timestamp, market_question, event_title, taker_action, side, size, price, usdc_value

nansen research pm pnl-by-address --address $ADDR --limit 20
# → question, event_title, side_held, net_buy_cost_usd, unrealized_value_usd, total_pnl_usd, market_resolved
```

Note: addresses sourced from `top-holders` may return empty trade history — use `trades-by-market` to find addresses with confirmed activity.

Look at PnL across resolved vs unresolved markets to gauge trader skill. Large positions in trending categories signal conviction.
