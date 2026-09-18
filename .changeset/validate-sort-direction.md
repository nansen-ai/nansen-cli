---
"nansen-cli": patch
---

`--sort` now rejects a direction other than `asc`/`desc` and an empty field name with an `INVALID_PARAMS` error. Previously `--sort pnl_usd:sideways` was uppercased and sent to the API as `direction: SIDEWAYS`, which only failed later with an upstream 422.
