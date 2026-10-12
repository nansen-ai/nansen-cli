---
"nansen-cli": patch
---

Skip unfunded x402 payment options on every signing path. WalletConnect payments now try each compatible option cheapest first, check the connected wallet's token balance before asking for approval, and move on to the next option after a clean server rejection instead of failing on the first. Solana payments from local and Privy wallets check the USDC balance before signing. Privy payments now report the token they paid with, so the low-balance warning checks the right token.
