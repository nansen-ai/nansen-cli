---
"nansen-cli": patch
---

Fail with an actionable error when a Solana RPC cannot return an SPL mint's decimals, instead of silently assuming 9 and building a transfer or limit order with a mis-scaled amount
