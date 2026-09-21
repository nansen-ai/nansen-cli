---
"nansen-cli": patch
---

`research token screener --search` now honours `--page`. The search filter runs client-side, and previously every page returned the same first slice of matches; the candidate fetch is now widened to cover the requested page and the filtered list is sliced at the page offset.
