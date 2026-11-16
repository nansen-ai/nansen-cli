---
"nansen-cli": patch
---

`wallet send` now refuses sends that would lose funds: a mixed-case EVM `--to` or `--token` address with an invalid EIP-55 checksum (all-lowercase and all-uppercase addresses still work), an ERC-20 sent to its own contract, and on Solana a recipient that is not a wallet (a token account, mint, program or other program-owned account). `--amount <number>` together with `--max` is now rejected with `INVALID_INPUT` instead of sending the whole balance.
