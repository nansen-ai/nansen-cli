---
"nansen-cli": patch
---

`wallet send --dry-run` from a Privy wallet on Solana now runs the same checks as the real send, so it refuses an SPL amount above the token balance, a send with no source token account, and a SOL amount above the SOL balance. The dry run now makes read-only RPC calls; it still never signs.
