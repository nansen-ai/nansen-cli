---
"nansen-cli": patch
---

`alerts update` now reads the alert it changes from the API even when `--cache` is on. It used to read it from the response cache, so an update run within the cache TTL of an earlier `alerts list` or `alerts update` merged the new flags into a stale copy of the alert. The PATCH then sent the old filters back and undid any change made since, and an alert created in the meantime was reported as "Alert not found".
