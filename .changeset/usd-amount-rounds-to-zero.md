---
"nansen-cli": patch
---

`trade quote` refuses an amount that resolves to zero base units (for example a fraction of a cent with `--amount-unit usd`) instead of requesting a quote for nothing
