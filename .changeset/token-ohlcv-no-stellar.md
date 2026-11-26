---
"nansen-cli": patch
---

`research token ohlcv` no longer accepts `--chain stellar`, matching the API, which never served OHLCV data for Stellar. `stellar` is also dropped from the research chain list, since no research endpoint accepts it as a chain input any more.
