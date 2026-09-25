---
name: nansen-wallet-deep-dive
description: "Who is this wallet and what have they been doing? Identity labels, balance, PnL summary, recent transactions, perp positions, and counterparties."
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


# Wallet Analysis

**Answers:** "Who is this wallet and what have they been doing?"

```bash
ADDR=<address> CHAIN=ethereum

nansen research profiler labels --address $ADDR --chain $CHAIN
# → label, category (e.g. "Smart Trader", "Fund", "Public Figure", ENS names)

nansen research profiler balance --address $ADDR --chain $CHAIN
# → token_symbol, token_name, token_amount, price_usd, value_usd per holding

nansen research profiler pnl-summary --address $ADDR --chain $CHAIN --days 30
# → realized_pnl_usd, realized_pnl_percent, win_rate, traded_token_count, traded_times, top5_tokens

nansen research profiler transactions --address $ADDR --chain $CHAIN --limit 20
# → block_timestamp, method, tokens_sent, tokens_received, volume_usd, source_type

nansen research profiler perp-positions --address $ADDR
# → asset_positions, margin_summary_account_value_usd, margin_summary_total_margin_used_usd

nansen research profiler counterparties --address $ADDR --chain $CHAIN --days 30
# → counterparty_address, counterparty_address_label, interaction_count, total_volume_usd, volume_in/out_usd
```

perp-positions returns Hyperliquid data — returns empty if the wallet has no open perps.
