---
"nansen-cli": minor
---

Add `nansen alerts` command for managing smart alerts (list, create, update, toggle, delete).

Supports three alert types: `sm-token-flows`, `common-token-transfer`, and `smart-contract-call`.
Named flags (`--inflow-1h-min`, `--chains`, `--telegram`, etc.) let you build alerts without raw JSON;
a `--data` escape hatch is available for full config overrides.

Also adds a `nansen-alerts` skill for agent integration.
