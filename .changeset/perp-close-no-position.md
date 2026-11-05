---
"nansen-cli": patch
---

`nansen perp close --dry-run` now exits 1 with `NO_OPEN_POSITION` when the wallet has no open position in that coin, instead of printing a plan and exiting 0 for a close Hyperliquid would reject. A real close is unchanged and still goes to Hyperliquid. If positions cannot be loaded, or the data for that coin is malformed, the dry run still prints the plan with "Open position: could not be loaded".
