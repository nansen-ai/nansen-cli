---
"nansen-cli": patch
---

x402 auto-payment with a Privy default wallet now tries the payment options cheapest first, like the local wallet and WalletConnect. It used to sign them in the server's order (every EVM option before Solana), so a 402 that listed a pricier option first was paid that one. Privy also no longer signs a Permit2 (`permit2-exact`) or unknown `assetTransferMethod` option as an EIP-3009 authorization the server cannot settle; it skips that option with the reason and tries the next one.
