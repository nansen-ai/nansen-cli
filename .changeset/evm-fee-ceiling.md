---
"nansen-cli": patch
---

EVM swaps, approvals and bridge deposits refuse a transaction whose worst-case gas cost (fee cap × gas limit) exceeds 1 ETH, checked for the swap before any approval is sent. `--max-tx-fee <eth>` on `trade execute` and `bridge execute` changes the cap, and `0` disables it. A fee or gas limit that is zero, negative or malformed is refused too.
