---
"nansen-cli": patch
---

fix: x402 balance check now respects NANSEN_BASE_RPC env override

Previously, `checkX402Balance` hardcoded `https://mainnet.base.org` for EVM USDC
balance queries, ignoring the `NANSEN_BASE_RPC` environment variable that PR #267
introduced for `trading.js` and `transfer.js`. Setting `NANSEN_BASE_RPC` now
applies consistently to x402 auto-payment balance checks as well.
