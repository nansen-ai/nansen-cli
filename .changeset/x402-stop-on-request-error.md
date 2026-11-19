---
"nansen-cli": patch
---

x402: when the paid retry fails with a request error (a 4xx other than 402, such as 400 or 404), the CLI now stops and reports the API's error instead of signing and sending the next payment option for the same request.
