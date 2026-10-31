---
"nansen-cli": patch
---

`trade limit-order list --offset N` now prints the correct "Showing …" range and next-page offset, and rejects an offset that is not a non-negative integer.
