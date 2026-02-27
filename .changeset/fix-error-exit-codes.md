---
"nansen-cli": patch
---

`nansen research <unknown>` and `nansen trade <unknown>` now exit with code 1 and return `{"success":false,...}` instead of silently exiting 0.
