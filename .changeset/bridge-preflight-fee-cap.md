---
"nansen-cli": patch
---

Check every EVM bridge transaction against the fee cap before broadcasting the first step, so an over-cap deposit cannot leave a paid approval behind.
