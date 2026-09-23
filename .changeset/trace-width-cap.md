---
"nansen-cli": patch
---

`research profiler trace` clamps `--width` to 1-50 (as `--depth` is clamped to 1-5) and stops expanding the counterparty graph after 1000 nodes, reporting `stats.truncated`, so a hub address can no longer turn one command into hundreds of API calls
