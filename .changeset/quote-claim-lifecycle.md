---
"nansen-cli": patch
---

`trade execute`: keep a quote claimed whenever a transaction may have left this process, and stop rather than falling through to the next candidate. An application-level failure that still carries a transaction identifier is now terminal and records that hash, approval and allowance-revoke broadcasts retain the claim so a quote cannot be reused while the wallet's allowance state is unknown, and a post-broadcast allowance verification failure ends the command instead of swapping against an allowance of unknown value. A candidate that throws after the swap was handed off is treated as ambiguous and marks the quote spent. Conversely, a backend failure response carrying no transaction identifier now releases the local claim, so a quote that was never broadcast is not left unusable.
