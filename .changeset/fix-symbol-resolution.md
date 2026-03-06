---
"nansen-cli": patch
---

fix: expand token symbol table and add unrecognised-symbol hint for trade commands

- Adds JUP, BONK, WIF, JTO, PYTH, RNDR, RAY to Solana symbol map
- Adds WBTC, CBBTC, CBETH, WSTETH, DAI, USDS, AERO, BRETT, TOSHI, DEGEN, WELL to Base symbol map
- `resolveTokenAddress` now emits a stderr hint when a short all-uppercase token-like string is not in the known-symbol table, preventing silent misrouting to the quote API as a malformed address
- Raw 0x addresses and full-length Solana addresses are passed through silently as before
