---
name: nansen-token-transfer-analysis
description: "Where is this token moving and why? Large transfers, flow trends over time, and breakdown by wallet label."
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


# Token Forensics

**Answers:** "Where is this token moving? Who is sending it and where?"

```bash
TOKEN=<address> CHAIN=ethereum
# Examples: UNI on ethereum (0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984)
#           BONK on solana (DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263)
# Note: token flows does NOT support stablecoins (USDC, USDT, etc.) — use non-stablecoin tokens

nansen research token transfers --token $TOKEN --chain $CHAIN --days 7 --limit 20
# → from_address_label, to_address_label, transfer_amount, transfer_value_usd

nansen research token flows --token $TOKEN --chain $CHAIN --days 7 --limit 20
# → date, price_usd, holders_count, total_inflows_count, total_outflows_count
# ⚠ Returns HTTP 422 for stablecoins — skip this command if TOKEN is a stablecoin

nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → net_flow_usd per label: smart_trader, whale, exchange, fresh_wallets, public_figure
```

Rising exchange_net_flow + large transfers to exchange addresses = potential sell pressure. Fresh wallet inflows may signal new interest or wash trading.
