---
"nansen-cli": patch
---

`perp order` and `perp close` refuse a price or size at or above 1e21 instead of encoding it as `"1e+21"` in the signed action, which Hyperliquid rejects after signing
