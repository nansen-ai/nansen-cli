---
"nansen-cli": patch
---

`trade execute` on Solana now also counts the rent of the token accounts a swap makes your wallet create when it checks your SOL balance before signing. A wallet that can pay the fee but not that rent skips the quote with the amount it needs, instead of signing a transaction that fails. This check also runs with `--no-verify-outcome`.
