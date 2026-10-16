---
"nansen-cli": patch
---

`trade execute` on Solana now checks, before signing, that the wallet holds enough SOL for the transaction's actual network fee (base plus priority fee, priced by the cluster). A quote the wallet cannot pay the fee for is skipped with an actionable error instead of being broadcast to fail on-chain. The check runs even with `--no-verify-outcome`, and if the balance lookup fails it warns and proceeds.
