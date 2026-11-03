---
"nansen-cli": patch
---

WalletConnect x402 payments now bound the authorization's `validBefore`. A `maxTimeoutSeconds` sent as a string (`"60"`) was concatenated onto the current time, giving a `validBefore` thousands of years out, and a large number was used as is; the timeout is now read as a whole number of seconds and capped at one hour, the window the local signer uses.
