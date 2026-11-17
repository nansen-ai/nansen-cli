---
"nansen-cli": patch
---

Privy signing now checks the signed transaction Privy returns before it is used. The transaction must be exactly the one the CLI sent for signing and checked, signed by the wallet; otherwise the CLI stops with `SIGNED_TX_MISMATCH` and broadcasts nothing. This covers `trade execute` (swaps, approvals and allowance revokes), `wallet send` on Solana, limit orders and x402 payments.
