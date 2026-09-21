---
"nansen-cli": patch
---

Recognise the API's full set of structured error codes. A 401 `unauthenticated` response once again shows `Not logged in. Run: nansen login`, `insufficient_credits` gets its do-not-retry hint, and codes that previously leaked through as raw server strings now surface as CLI codes, including the new `PLAN_UPGRADE_REQUIRED`, `GEO_BLOCKED`, `QUERY_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `METHOD_NOT_ALLOWED`, and `CONFLICT`. Retry behaviour is unchanged: it stays keyed on the HTTP status.
