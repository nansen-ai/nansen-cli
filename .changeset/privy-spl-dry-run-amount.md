---
"nansen-cli": patch
---

`wallet send --dry-run` from a Privy wallet now rejects a malformed, zero or too-small SPL token amount on Solana, as the real send does, instead of previewing it as a success.
