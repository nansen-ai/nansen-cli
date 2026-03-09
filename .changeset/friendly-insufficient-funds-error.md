---
"nansen-cli": patch
---

fix: show human-readable error when trade fails due to insufficient ETH

When a wallet has no ETH and a trade is attempted, the raw Ethereum RPC
error ("insufficient funds for gas * price + value: ... have 0 want
400000000000000 (supplied gas 600000000)") is now translated into a
user-friendly message showing amounts in ETH with a funding hint, e.g.
"Insufficient ETH: wallet has 0.000000 ETH but this trade needs ~0.000400
ETH (amount + gas). Send ETH to 0x... before trading."
