---
"nansen-cli": patch
---

`trade execute` now sizes ERC-20 approvals from the same quote input field that the input-amount and maximum-input checks read. A quote with an empty `inputAmount` is now refused by those input checks before any approval or signing, instead of passing as a zero input and being approved for its `inAmount`. `trade quote` and the execute plan show the input from `inputAmount` (falling back to `inAmount` only when `inputAmount` is absent), or `?` when it is empty.
