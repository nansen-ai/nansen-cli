---
"nansen-cli": patch
---

`trade execute`: a WalletConnect send that fails after the wallet was asked to broadcast now ends the command instead of trying the next candidate quote. The WalletConnect helpers collapse a user rejection, a 120-second approval timeout and a spawn failure into the same error, so none of them proves the wallet did not broadcast; every send is now tagged ambiguous at that boundary and treated as terminal. This covers the swap, approval, allowance-revoke and Solana paths, and a wallet reply carrying neither a transaction hash nor signed bytes.
