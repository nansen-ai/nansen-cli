---
"nansen-cli": patch
---

`trade execute` now sizes ERC-20 approvals from the same quote input field that the input-amount and maximum-input checks read. A quote with an empty `inputAmount` is refused before any approval instead of being approved for its `inAmount`.
