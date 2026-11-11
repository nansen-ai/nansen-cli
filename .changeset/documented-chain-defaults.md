---
"nansen-cli": minor
---

Research commands now report the chain they used when `--chain` is left out, as `_meta.defaults.chain` in the JSON response. `--help` and `nansen schema` now show the default chain each command actually uses: `token indicators` defaults to `solana` (it said `ethereum`), the wallet `profiler` commands default to `all` (they said `ethereum`), and `smart-money-pnl-leaderboard`, `historical-smart-money-balances` and `historical-token-screener` now document their `solana` default. No command's default chain changed.
