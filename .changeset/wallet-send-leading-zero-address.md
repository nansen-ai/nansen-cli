---
"nansen-cli": patch
---

`wallet send` on EVM keeps the leading zero bytes of the recipient (or token contract) address in the signed transaction. They were stripped, so a send to an address such as `0x00000000219ab540356cBB839Cbe05303d7705Fa`, or of a token such as TrueUSD (`0x0000000000085d4780B73119b644AE5ecd22b376`), was rejected by the node, and a send to the zero address was signed as a contract creation.
