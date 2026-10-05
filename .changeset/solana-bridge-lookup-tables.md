---
"nansen-cli": patch
---

Solana-source bridge routes that are too large to fit in a transaction without address lookup tables (for example a token swap ahead of the bridge deposit) now compile and sign. The CLI fetches the route's lookup tables, checks that each one is active and on-chain, and uses them to compress accounts. Routes that already fit are compiled as before.
