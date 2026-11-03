---
"nansen-cli": patch
---

A `--paginate` result that mixes cached and live pages is no longer reported as a cache hit. The merged result kept page 1's `_meta.fromCache`/`cacheAge`, and telemetry's `from_cache` followed page 1's marker or the last page's cache state; both now say cached only when every page came from the cache.
