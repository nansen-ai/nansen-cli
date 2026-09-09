---
"nansen-cli": patch
---

Report `from_cache` telemetry from the API instance so it survives command handlers that rebuild their result, and pass it on the `alerts list --table` path, which previously never reported the field at all
