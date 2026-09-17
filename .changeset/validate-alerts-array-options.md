---
"nansen-cli": patch
---

Validate `alerts create`/`update` array-style options (`--events`, `--token-sector`, `--exclude-token-sector`, `--signature-hash`) so non-string values (booleans, `null`, or non-string elements in a repeated flag) raise `INVALID_PARAMS` instead of being sent to the API as-is.
