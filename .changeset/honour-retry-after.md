---
"nansen-cli": patch
---

Respect the server's `Retry-After` header when retrying rate-limited (429) requests. The wait was capped at the local backoff ceiling (30s), so a `Retry-After: 60` led to a retry after 30s that could only hit the limiter again. The client now waits at least as long as the header asks, and if the server asks for more than `maxRetryAfterMs` (default 120s) it fails immediately with the `retryAfterMs` in the error details instead of retrying too early. A `Retry-After` on a 5xx response is still treated as advisory and capped at the backoff ceiling as before.
