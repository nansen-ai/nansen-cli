---
"nansen-cli": patch
---

`bridge execute` now refuses a Hyperliquid withdrawal quote that has more than one withdrawal leg, or whose withdrawal is not sent to Relay's deposit address, before signing anything.
