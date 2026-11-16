---
"nansen-cli": patch
---

`nansen perp transfer` and `nansen perp approve-builder-fee` now honour `--dry-run` and `--yes` like the other perp commands that change state: `--dry-run` prints the plan and signs nothing, an interactive terminal asks before signing, and `NANSEN_REQUIRE_CONFIRM=1` applies off a terminal. Previously both signed and submitted even with `--dry-run`.
