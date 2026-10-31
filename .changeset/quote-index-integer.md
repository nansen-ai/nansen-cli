---
"nansen-cli": patch
---

`trade execute --quote-index` now rejects values that are not whole numbers (`1.9`, `1abc`, `1e0`) instead of pinning the quote at their leading digits.
