---
name: nansen-prediction-markets
description: "Polymarket screeners — discover trending events, top markets by volume, and search for specific markets. Use when browsing what's happening on prediction markets."
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

# Prediction Market Screeners

All commands: `nansen research prediction-market <sub> [options]` (alias: `nansen research pm <sub>`)

No `--chain` flag needed — Polymarket runs on Polygon.

```bash
# Top events (groups of related markets)
nansen research pm event-screener --sort-by volume_24hr --limit 20
# → event_title, market_count, total_volume, total_volume_24hr, total_liquidity, total_open_interest, tags

# Top markets by 24h volume
nansen research pm market-screener --sort-by volume_24hr --limit 20
# → market_id, question, best_bid, best_ask, volume_24hr, liquidity, open_interest, unique_traders_24h

# Search for specific markets
nansen research pm market-screener --query "bitcoin" --limit 10

# Find resolved/closed markets
nansen research pm market-screener --status closed --limit 10

# Browse categories
nansen research pm categories --pretty
# → category, active_markets, total_volume_24hr, total_open_interest
```

Sort options: `volume_24hr`, `volume`, `volume_1wk`, `volume_1mo`, `liquidity`, `open_interest`, `unique_traders_24h`, `age_hours`

Screeners return active/open markets by default. Use `--status closed` for resolved markets.
