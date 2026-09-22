---
"nansen-cli": patch
---

`alerts update` no longer resends a PATCH through the retry loop after a transient failure, matching `alerts create`
