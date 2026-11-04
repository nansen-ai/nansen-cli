---
"nansen-cli": patch
---

`--sort` now rejects extra colon segments (`--sort value_usd:desc:asc`) instead of silently dropping them, and `--order-by` rejects anything that is not a JSON array of `{ "field", "direction" }` objects instead of sending it to the API unchecked.
