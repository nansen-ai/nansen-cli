---
"nansen-cli": patch
---

fix: add `trades` as alias for `dex-trades` in smart-money subcommands

Agents naturally try `nansen research smart-money trades` before discovering the canonical name `dex-trades`. This adds `trades` as a transparent alias so both work identically. The schema is also updated to list the alias.
