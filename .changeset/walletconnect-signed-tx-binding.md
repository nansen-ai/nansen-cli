---
"nansen-cli": patch
---

WalletConnect signing now checks a signed transaction the wallet returns before the CLI broadcasts it. It must be signed by the connected wallet and carry the chain, recipient, value, calldata and gas limit the CLI sent (for Solana, the exact message); a signature-only Solana reply must verify. Otherwise the CLI stops with `SIGNED_TX_MISMATCH` and does not broadcast it. This covers `trade execute` (swaps, approvals and allowance revokes), `wallet send` on EVM chains and limit orders.
