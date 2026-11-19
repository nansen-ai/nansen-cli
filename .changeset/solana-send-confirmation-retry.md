---
"nansen-cli": patch
---

`wallet send --chain solana` no longer reports a broadcast transfer as failed when a confirmation poll hits a network or RPC error (for example `fetch failed`). It keeps polling and prints the signature, so the transfer is not mistaken for a failed send and sent again. An `err` seen at `processed`, which can still be rolled back, is no longer treated as final: the send waits for a `confirmed` status. A transfer that failed on-chain is reported with its signature.
