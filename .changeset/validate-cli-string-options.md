---
"nansen-cli": patch
---

Validate more CLI string options (`profiler batch --include`, `perp screener --sectors-filter`/`--sm-label-filter`/`--trader-label-filter`, `prediction-market market-screener`/`event-screener --tags`, and `--fields`) so JSON primitives produce actionable `INVALID_PARAMS` errors instead of raw `.split()`/`.trim()` TypeErrors.
