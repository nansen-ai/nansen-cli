---
"nansen-cli": patch
---

`trade execute`: when the standard execution route rejects a swap before broadcasting it (quote expired, simulation failed, minimum return not reached, insufficient balance, input transfer failed), the CLI now releases the quote and tries the next candidate quote instead of aborting and marking the quote spent. Every other error response still stops the run.
