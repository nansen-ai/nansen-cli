---
"nansen-cli": patch
---

Report an API error whose body has a non-string `message` or `error` field (for example `{"error": {"message": "..."}}`) as a normal error instead of crashing with `message.toLowerCase is not a function`.
