---
"nansen-cli": patch
---

Fix exit codes for unknown research category and trade subcommand errors.

Previously, `nansen research <unknown>` returned `{"success":true,"data":{"error":"..."}}` and
exited with code 0 — a contract violation that silently swallowed errors in scripts.
`nansen trade <unknown>` also exited 0 without structured error output.

Now both commands exit with code 1 and return proper `{"success":false,"error":"...","code":"UNKNOWN"}`
JSON, consistent with all other error paths. The NO_AUTH_COMMANDS execution path is also wrapped
in a try/catch so any future errors there are handled correctly.
