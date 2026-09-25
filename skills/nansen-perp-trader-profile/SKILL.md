---
name: nansen-perp-trader-profile
description: "Deep dive on a Hyperliquid perp trader. Identity, open positions, recent trades, and overall PnL."
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

# Perp Trader

**Answers:** "What is this perp trader doing? What are their positions and track record?"

```bash
ADDR=<address>

nansen research profiler labels --address $ADDR --chain ethereum
# → label, category (identity, SM labels)

nansen research profiler perp-positions --address $ADDR
# → asset_positions, margin_summary_account_value_usd, margin_summary_total_margin_used_usd

nansen research profiler perp-trades --address $ADDR --days 7 --limit 20
# → timestamp, token_symbol, side, action (Open/Close/Reduce), price, size, value_usd, closed_pnl, fee_usd

nansen research perp leaderboard --days 7 --limit 50
# → trader_address, total_pnl, roi, account_value (check if ADDR appears)
```

Cross-reference perp-trades with perp-positions to see if the trader is scaling in/out. Leaderboard shows relative standing.
