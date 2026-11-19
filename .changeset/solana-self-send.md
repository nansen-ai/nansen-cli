---
"nansen-cli": patch
---

`wallet send --chain solana` now refuses a send to the wallet's own address before signing, with a message that says why, instead of failing with "Transaction simulation failed". Failed Solana simulations now include the RPC's `err` value (for example `AccountLoadedTwice`) in the error text.
