---
"nansen-cli": minor
---

Add `nansen cache stats` and safe cache controls. `nansen cache stats` reports, for each cache the CLI keeps under `~/.nansen` (saved API responses, the credit cost map, the update check), how many entries it holds, how many bytes that is on disk, the age of its oldest and newest entry, the effective TTL, and how many entries are already expired — as a text report, or as an object with `--json`. Hits and misses are not recorded on disk, and the report says so rather than guessing.

`nansen cache clear` now takes an explicit target — `responses` (the default), `cost-map`, `update-check` or `all` — and prints exactly what it removed. It only ever deletes entries in the cache it was pointed at; credentials, wallets, saved quotes and config are never touched, and a symlink in the cache directory is skipped rather than followed.

Which commands cache is now documented rather than guessable: `nansen schema` carries a `caching` section, `nansen cache` explains it in its own help, and `--cache`/`--no-cache` are listed in the schema's global options alongside `--cache-ttl`. `NANSEN_NO_CACHE=1` is a new flagless equivalent of `--no-cache`, for wrappers that cannot change the command line.

Stats are aggregates only: no cached payload, request parameter, endpoint path or cache key is ever printed.
