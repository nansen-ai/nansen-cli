---
"nansen-cli": patch
---

Keep the body of a non-JSON error response (gateway HTML, plain text) in the error details instead of reporting `body: null`, and apply the same retry policy to it as to a JSON error: a plain-text `429` is now retried, with its `Retry-After` respected, instead of failing on the first attempt.
