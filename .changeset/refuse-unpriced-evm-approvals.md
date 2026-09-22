---
"nansen-cli": patch
---

Refuse to sign EVM approval, revoke, and Privy swap transactions when the quote carries no gas price, instead of defaulting to an unmineable 0.001 gwei fee that left the wallet's nonce stuck
