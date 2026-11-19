---
"nansen-cli": patch
---

`wallet send --chain solana` no longer reports a broadcast transfer as failed when a confirmation poll hits a network or RPC error (for example `fetch failed`). It keeps polling and prints the signature, so the transfer is not retried and sent twice. A transfer that failed on-chain is reported with its signature.
