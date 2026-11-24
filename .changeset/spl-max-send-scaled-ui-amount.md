---
"nansen-cli": patch
---

`wallet send --chain solana --token <mint> --max` now sends the token account's whole balance for Token-2022 mints with the ScaledUiAmount or InterestBearing extension. It used the RPC's scaled `uiAmountString`, which differs from the balance (for xStocks such as AAPLx it is larger, so the send failed with "Insufficient token balance: have X, need X"). The insufficient-balance error now reports the balance in the same units as `--amount`.
