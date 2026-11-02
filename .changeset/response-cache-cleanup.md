---
"nansen-cli": patch
---

Response cache (`--cache`) no longer grows without bound. After a cached write, entries older than 24 hours (or the `--cache-ttl` in use, if longer) and temp files left by an interrupted write are removed, at most once an hour per run. `nansen cache clear` also removes those leftover temp files, but never one younger than 10 minutes, which may be a write in progress.
