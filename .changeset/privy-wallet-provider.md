---
"nansen-cli": minor
---

Unified wallet abstraction: Privy server wallets are first-class citizens.

- `wallet create --provider privy` creates EVM + Solana wallets via Privy and stores a local reference
- All wallet commands (list, show, delete, default, send) work by name regardless of provider
- Trading (quote + execute) supports Privy wallets with sign-only + Trading API broadcast
- x402 auto-payment routes through Privy when credentials are configured
