---
"nansen-cli": patch
---

Reject hard-linked `.credentials` files in the wallet-password fallback write, so the credential write cannot chmod, truncate, or overwrite an unrelated file
