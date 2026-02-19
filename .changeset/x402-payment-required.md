---
"nansen-cli": minor
---

Add x402 payment required handling. HTTP 402 responses now return a `PAYMENT_REQUIRED` error code with decoded payment requirements (network, amount, asset, payTo) from the x402 protocol.
