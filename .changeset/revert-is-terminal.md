---
"nansen-cli": patch
---

`trade execute`: a confirmed on-chain revert now ends the command instead of signing and broadcasting the next candidate quote. The revert is reported with its hash and explorer link as before, and the user is told to review that transaction and request a fresh quote. `waitForReceipt` tags the failure `TX_REVERTED` rather than relying on the error message text.
