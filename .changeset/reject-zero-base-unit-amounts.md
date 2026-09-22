---
"nansen-cli": patch
---

`wallet send` and `trade limit-order create` reject an amount of zero, or one that truncates to zero base units at the token's precision, instead of broadcasting a transfer of nothing or creating a limit order with `inputAmount: "0"`
