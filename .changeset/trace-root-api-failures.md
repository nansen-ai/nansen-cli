---
"nansen-cli": patch
---

Report the original API error when a profiler trace's root lookup fails instead of returning a successful empty graph. Keep later branch lookups best-effort after a successful root lookup.
