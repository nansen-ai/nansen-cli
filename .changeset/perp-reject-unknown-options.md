---
"nansen-cli": patch
---

`perp order`, `close`, `cancel`, `leverage`, `transfer` and `approve-builder-fee` now reject options they don't declare (for example a misspelled `--dryrun`) and stray arguments (for example `—dry-run` typed with an em dash) before any request or signature, with the same `unknown_field` error that research commands return. Previously these were ignored and the command went on to sign and submit.
