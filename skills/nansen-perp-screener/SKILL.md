---
name: nansen-perp-screener
description: "What is the state of the Hyperliquid perp market? Top contracts by volume/OI, trader leaderboard, and SM perp activity."
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

# Perp Market Scan

**Answers:** "What's the state of the Hyperliquid perp market right now?"

```bash
nansen research perp screener --sort volume:desc --limit 20
# → token_symbol, volume, buy/sell_volume, buy_sell_pressure, open_interest, funding, mark_price

nansen research perp leaderboard --days 7 --limit 20
# → trader_address, trader_address_label, total_pnl, roi, account_value

nansen research smart-money perp-trades --limit 20
# → token_symbol, side, action (Open/Close), value_usd, price_usd, trader_address_label
```

## New Filters (ECINT-6680)

### `--trader-type`
Filter by trader type. Accepted values: `all` (default), `sm`, `whale`, `public_figure`, `high_winrate_hl_perps_trader`.

```bash
# Show only whale traders
nansen research perp screener --trader-type whale --limit 10

# Show only smart money traders
nansen research perp screener --trader-type sm --limit 20

# Show high win-rate HL perps traders
nansen research perp screener --trader-type high_winrate_hl_perps_trader --limit 20
```

### `--sm-label-filter`
Comma-separated Nansen SM labels to filter by. Only applies when `--trader-type` is `all` or `sm`.

```bash
# Filter to a specific SM label
nansen research perp screener --trader-type sm --sm-label-filter "30D Smart Trader"

# Multiple labels
nansen research perp screener --sm-label-filter "30D Smart Trader,Smart LP"
```

### `--trader-label-filter`
Comma-separated HL perps trader labels to filter by. Only applies when `--trader-type` is `all` or `sm`.

```bash
# Filter to HL Perps Whale label
nansen research perp screener --trader-label-filter "HL Perps Whale"
```

### `--sectors-filter`
Comma-separated `category:subcategory` pairs to filter coins by sector.

```bash
# Filter to AI and DeFi crypto sectors
nansen research perp screener --sectors-filter "Crypto:AI,Crypto:DeFi" --trader-type whale

# Combine with trader type and limit
nansen research perp screener --sectors-filter "Crypto:AI,Crypto:DeFi" --trader-type whale --limit 10 --sort volume:desc
```

## Combined Examples

```bash
# Whale traders in AI crypto, sorted by volume
nansen research perp screener --trader-type whale --sectors-filter "Crypto:AI" --sort volume:desc --limit 10

# Smart money with specific label, last 7 days
nansen research perp screener --trader-type sm --sm-label-filter "30D Smart Trader" --days 7 --limit 20

# All traders in TradFi stocks sector
nansen research perp screener --sectors-filter "TradFi:Stocks" --sort open_interest:desc --limit 20
```
