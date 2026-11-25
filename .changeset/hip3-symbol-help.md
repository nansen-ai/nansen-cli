---
"nansen-cli": patch
---

Help text now names Hyperliquid HIP-3 (builder-deployed) markets. `research token perp-positions`, `perp-trades`, `perp-pnl-leaderboard`, `research position-intelligence` and `research token ohlcv --chain hyperliquid` show that a HIP-3 market is passed as `dex:SYMBOL`, for example `xyz:NVDA`. The `research perp`, `smart-money perp-trades` and `profiler perp-*` commands say their results include HIP-3 markets. `perp order`, `close`, `cancel` and `leverage` say they trade native perps only.
