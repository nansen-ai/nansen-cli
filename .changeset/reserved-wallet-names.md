---
"nansen-cli": patch
---

`wallet create` now rejects the names `config` (any case), `wc` and `walletconnect`. A wallet named `config` was saved as `wallets/config.json` and then overwritten by the wallet settings, losing its keys; `wc` and `walletconnect` are read as WalletConnect by `wallet send` and limit orders.
