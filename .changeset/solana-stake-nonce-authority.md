---
"nansen-cli": patch
---

Solana trades: refuse to sign a transaction that changes who controls, or withdraws from, a stake or nonce account your wallet controls. The pre-sign simulation now compares those accounts' authorities and balances, and the instruction check rejects Stake-program instructions that name your wallet and nonce authorize/withdraw instructions your wallet authorizes.
