---
"nansen-cli": patch
---

Fix `nansen trade help` returning blank output. Now prints subcommands, usage, and examples. Also fixes `errorOutput` ReferenceError in `buildCommands` scope (affected `trade` and `changelog` commands).
