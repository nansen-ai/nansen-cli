---
"nansen-cli": patch
---

A blank (`--fields ' , '`, bare `--fields`) or repeated `--fields` is now rejected before the request is made, instead of after a billed call or by silently returning every field.
