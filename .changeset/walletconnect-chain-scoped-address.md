---
"nansen-cli": patch
---

Fix `nansen transfer`/`nansen trade execute` with `--wallet walletconnect` using any connected EVM account instead of verifying the WalletConnect session is actually approved for the chain being signed/broadcast on.

`getWalletConnectAddress('evm')` matched any account whose CAIP-2 chain tag started with `eip155:`, regardless of which specific chain it was approved for. Because EVM addresses are identical across chains, a session connected only to Ethereum mainnet would be silently used to sign a transaction destined for Base (or vice versa) -- nothing downstream (including the quote/request-intent binding checks) could catch this, since they only compare addresses, not chains.

`getWalletConnectAddress` now accepts an optional `chainId`, and when given, only returns an account the session has approved for that exact chain (mirroring the mainnet-only exact match already used for Solana in the same function). Every place that resolves a WalletConnect EVM address before signing or broadcasting a real transaction now passes the target chain ID and fails closed with a clear error instead of proceeding with a wrong-chain session: `nansen transfer`'s `sendTokensViaWalletConnect`, and `nansen trade execute`'s quote-building, pre-execute wallet-match check, and immediate pre-signing check for its EVM WalletConnect swap path.
