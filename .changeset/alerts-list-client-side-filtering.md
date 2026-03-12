---
"nansen-cli": patch
---

Fix `alerts list` filtering (`--type`, `--enabled`, `--disabled`, `--chain`, `--token-address`, `--limit`, `--offset`).

Filters were sent as query params but silently ignored by the API. Now applied client-side after fetching all alerts.
