---
"nansen-cli": patch
---

`nansen perp order`, `cancel`, `close` and `leverage` now reject a HIP-3 market symbol (`dex:SYMBOL`, such as `xyz:NVDA`) up front with `INVALID_INPUT`, saying that only native Hyperliquid perps can be traded, instead of failing with a misleading `META_UNAVAILABLE` error.
