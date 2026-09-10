---
"nansen-cli": patch
---

Fix x402 auto-payment via WalletConnect signing a payment authorization from any connected EVM account instead of verifying the WalletConnect session is actually approved for the payment's chain.

`handleX402Payment` resolved its signer with its own `checkWalletConnection()` helper and took `wallet.accounts[0]?.address` with no chain filtering at all -- the same defect class fixed in `getWalletConnectAddress` for `nansen transfer`/`nansen trade execute` (see the WalletConnect chain-scoped signing fix), just left unguarded here because this path never reused that helper. Because EVM addresses are identical across chains, a WalletConnect session approved only for, say, Base could be silently used to authorize an x402 payment on BNB Smart Chain or X Layer -- the other two EVM networks Nansen's x402 payments support.

`handleX402Payment` now resolves its signer via `getWalletConnectAddress('evm', chainId)`, scoped to the exact chain of the selected payment requirement, and refuses to pay with a clear error when no WalletConnect session is approved for that chain. The now-unused, duplicate `checkWalletConnection` helper was removed.
