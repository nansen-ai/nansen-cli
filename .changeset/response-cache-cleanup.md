---
"nansen-cli": patch
---

Response cache (`--cache`) no longer grows without bound. After a cached write, entries older than 24 hours and temp files left by an interrupted write are removed (once per run). `nansen cache clear` also removes those leftover temp files, but never one younger than 10 minutes, which may be a write in progress.
