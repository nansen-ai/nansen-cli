---
"nansen-cli": patch
---

WalletConnect results are parsed without counting braces inside string values, so a wallet message containing `}` no longer makes a successful transaction or x402 payment look like a failure
