---
"nansen-cli": patch
---

`perp order` now rejects a take-profit or stop-loss on the wrong side of entry before resolving the signing context, so a wallet's first order no longer submits the one-time builder-fee approval on chain for an order that was never valid
