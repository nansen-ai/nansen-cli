---
"nansen-cli": patch
---

fix: `wallet list` no longer emits a plain-text prefix before the JSON payload

`nansen wallet list` was calling `log()` (stdout) to print a human-readable
message ("No wallets found…" or the formatted wallet table) **and** returning
the result object, which the framework also serialised to JSON on stdout.
The combined output was an unparseable mix of plain text followed by JSON,
breaking every downstream consumer: `jq`, `JSON.parse`, and agent tool-call
handlers that expect clean JSON.

The `log()` calls have been removed from the `list` handler. The framework's
JSON output already carries the full picture:

- empty  → `{ "success": true, "data": { "wallets": [], "defaultWallet": null } }`
- filled → `{ "success": true, "data": { "wallets": [...], "defaultWallet": "..." } }`

Three new unit tests guard against regression.
