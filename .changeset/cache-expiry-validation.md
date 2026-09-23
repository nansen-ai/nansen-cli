---
"nansen-cli": patch
---

Use the default response TTL when cache stats receives an invalid TTL. Reject invalid clock values. Match the expiry boundary used by each cache reader, and reject invalid timestamp metadata in the readers.
