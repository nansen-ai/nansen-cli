---
"nansen-cli": patch
---

An API error response whose body is the JSON value `null` is now reported as a normal API error for its status (and retried when the status is retryable) instead of crashing with `Cannot read properties of null (reading 'message')`.
