---
"nansen-cli": patch
---

`trade execute` on Solana now checks, before signing, that the wallet holds enough SOL for the transaction's actual network fee (base plus priority fee) and the rent of any accounts it creates. A quote the wallet cannot pay for is skipped with an actionable error instead of being broadcast to fail on-chain. The check runs even with `--no-verify-outcome`, and if the balance lookup fails it warns and proceeds.
