---
"nansen-cli": patch
---

Reject a comma-separated `--chain` (for example `--chain eth,sol`) with a message pointing to `--chains`, instead of sending it to the API as one unresolvable chain name.
