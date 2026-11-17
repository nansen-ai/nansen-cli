---
"nansen-cli": patch
---

`trade execute` now refuses a native-token EVM swap whose transaction value does not match the quote's input amount (the same field the request check reads) or exceeds the maximum spend saved with the quote, even when swap-outcome verification is off.
