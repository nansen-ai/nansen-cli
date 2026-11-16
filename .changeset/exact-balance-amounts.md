---
"nansen-cli": patch
---

`nansen trade quote` now works out `--amount-unit percent` amounts, and the amount it auto-adjusts to when `--amount` is slightly above the balance, from the exact base-unit balance. The balance used to be read as a JavaScript number, which cannot hold most 18-decimal balances or large 9-decimal SPL balances exactly. `--amount 100 --amount-unit percent` could then quote slightly more than the wallet holds (so the swap fails) or leave dust behind, an amount equal to the full balance was reported as exceeding it, and a very small balance became an amount like `5e-7` that was rejected as invalid.
