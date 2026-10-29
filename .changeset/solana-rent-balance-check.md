---
"nansen-cli": patch
---

`trade execute` on Solana now also counts the rent of the accounts a swap makes your wallet create (new token accounts, including Token-2022 accounts sized for their mint's extensions) when it checks your SOL balance before signing. A wallet that can pay the fee but not that rent skips the quote with the amount it needs, instead of signing a transaction that fails on chain. This check also runs with `--no-verify-outcome`.
