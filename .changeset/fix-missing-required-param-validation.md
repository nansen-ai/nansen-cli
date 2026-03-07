---
"nansen-cli": patch
---

fix: validate required params client-side in profiler, token, and research search commands

Previously, running a command like `nansen research profiler balance` without the required
`--address` flag would silently hit the API and return a misleading `UNAUTHORIZED` or
`PAYMENT_REQUIRED` error. The same was true for `nansen research token info` (missing
`--token`) and `nansen research search` (missing `--query`).

These commands now throw a `MISSING_PARAM` error immediately with a clear message and
usage example before making any network request.
