---
"nansen-cli": minor
---

Add `NANSEN_REQUIRE_CONFIRM=1`, an opt-in stop point for agents: when stdin is not a terminal, `trade execute`, `bridge execute`, `trade limit-order create`/`cancel` and `perp order`/`close`/`cancel`/`leverage` run without `--yes` (or `NANSEN_YES=1`) now fail with `CONFIRMATION_REQUIRED` before any request or signature. `--dry-run` still previews. Unset, behaviour is unchanged.
