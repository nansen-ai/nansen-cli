---
"nansen-cli": patch
---

Write wallet config and key files atomically with owner-only permissions regardless of umask, and report a corrupt wallet file by name instead of hiding every other wallet behind a JSON parse error
