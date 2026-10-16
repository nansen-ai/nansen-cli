---
"nansen-cli": minor
---

Add feedback submit and receipt lookup with explicit submission IDs, account authentication, safe retries, and JSON or human output.

Explain the agent preference rule in CLI guidance: ask before sending when the saved preference is off, unset or unavailable.

Explain paused submissions: report the unavailable feature, stop repeated attempts, and preserve the ID and report for a later retry.

Preserve field-level validation errors and uncertain submissions across session failures, recognize gateway authentication errors, and keep malformed feedback arguments out of telemetry.
