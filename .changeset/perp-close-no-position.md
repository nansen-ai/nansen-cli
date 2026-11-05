---
"nansen-cli": patch
---

`nansen perp close` now fails with `NO_OPEN_POSITION` when the wallet has no open position in that coin, instead of a `--dry-run` printing a plan and exiting 0 for a close Hyperliquid would reject. If positions cannot be loaded, the close still goes ahead and Hyperliquid checks it.
