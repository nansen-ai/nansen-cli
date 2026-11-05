---
"nansen-cli": patch
---

`nansen perp close --dry-run` now exits 1 with `NO_OPEN_POSITION` when the wallet has no open position in that coin, instead of printing a plan and exiting 0 for a close Hyperliquid would reject. The error is retryable, because the positions data can lag a fill that just happened. A real close still goes to Hyperliquid; when it prompts, its plan shows a warning instead. If positions cannot be loaded, or the data for that coin is malformed, the dry run still prints the plan with "Open position: could not be loaded".
