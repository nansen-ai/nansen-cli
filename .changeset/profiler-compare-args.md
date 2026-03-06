---
"nansen-cli": patch
---

fix: support --address1/--address2 aliases for profiler compare

Users naturally try `--address1 0xabc --address2 0xdef` but the CLI
only accepted `--addresses addr1,addr2`. Now both forms work, and the
error message shows the correct syntax when neither is provided.

Fixes runtime failure when --addresses argument parsing failed silently
(space-separated addresses dropped the second address without explanation).
