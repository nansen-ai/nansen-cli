---
name: nansen-wallet-batch
description: "Which of these addresses are smart money? Batch-profile a list in one call."
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

```bash
ADDRESSES="0xaddr1,0xaddr2,0xaddr3,..." CHAIN=ethereum
nansen research profiler batch --addresses "$ADDRESSES" --chain $CHAIN --include labels,balance
# → .data.{total, completed, results[]: {address, chain, labels[], balance, error}}
# labels[]: {label, category ("smart_money","fund","social","behavioral","others"), kind[]}
# balance: {data[]: {token_symbol, token_amount, price_usd, value_usd}}
```
Check .error per result — invalid addresses return an error message, not a crash. Skip those.
Keep addresses where any label.category == "smart_money" or "fund". Omit balance for faster checks.
