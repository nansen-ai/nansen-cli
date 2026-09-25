---
name: nansen-polymarket-deep-dive
description: "Deep dive on a Polymarket market — OHLCV, orderbook, top holders, positions, trades, and PnL leaderboard. Use when analysing a specific prediction market."
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

# Prediction Market Deep Dive

**Answers:** "What's happening in this specific market? Who holds it, who's trading it?"

Use `market_id` from the screener (`nansen-prediction-market` skill).

```bash
MID=<market_id>

nansen research pm ohlcv --market-id $MID --sort period_start:desc --limit 50
# → period_start, open, high, low, close, volume

nansen research pm orderbook --market-id $MID
# → bids[], asks[] with price and size

nansen research pm top-holders --market-id $MID --limit 20
# → address, side, position_size, avg_entry_price, current_price, unrealized_pnl_usd

nansen research pm position-detail --market-id $MID --limit 20
# → address, side, size, avg_entry_price, current_price, pnl

nansen research pm trades-by-market --market-id $MID --limit 20
# → timestamp, buyer, seller, taker_action, side, size, price, usdc_value

nansen research pm pnl-by-market --market-id $MID --limit 20
# → address, side_held, net_buy_cost_usd, unrealized_value_usd, total_pnl_usd
```

Notes:
- `--market-id` is a numeric ID from the screener, not a slug.
- Works with any market ID regardless of status (active or closed/resolved).
- All addresses are Polygon (EVM).
