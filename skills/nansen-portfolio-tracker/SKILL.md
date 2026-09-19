---
name: nansen-portfolio-tracker
description: "How has a wallet's portfolio changed over time? Historical balances, current snapshot, and per-token PnL."
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

# Portfolio History

**Answers:** "How has this wallet's portfolio evolved over the past month?"

```bash
ADDR=<address> CHAIN=ethereum

nansen research profiler historical-balances --address $ADDR --chain $CHAIN --days 30 --limit 20
# → block_timestamp, token_symbol, token_amount, value_usd, chain

nansen research profiler balance --address $ADDR --chain $CHAIN
# → token_symbol, token_name, token_amount, price_usd, value_usd

nansen research profiler pnl --address $ADDR --chain $CHAIN --days 30 --limit 20
# → token_symbol, pnl_usd_realised, roi_percent_realised, bought_usd, sold_usd, holding_usd, nof_buys, nof_sells
```

Compare historical-balances over time against current balance to see what was added/removed. PnL shows trade performance.
