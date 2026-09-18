---
"nansen-cli": patch
---

Validate `token screener --search` and `token who-bought-sold --buy-or-sell` before the request is sent, so JSON primitives (`--search true`, `--buy-or-sell []`) and values outside the `BUY`/`SELL` enum produce an actionable `INVALID_PARAMS` error instead of a raw `.toLowerCase()`/`.toUpperCase()` TypeError.
