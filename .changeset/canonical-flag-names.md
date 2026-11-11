---
"nansen-cli": minor
---

One flag name per input across commands, with the old names still accepted: `--token` for a token address (historical-* commands, `alerts list`, `trade limit-order list`; `--token-address` and `--mint` still work), `--days` for a lookback in days (`chain-rank`, `smart-money-pnl-leaderboard`, `historical-token-screener`; `--timeframe-days` still works), `--interval` for the candle size on `token ohlcv` and `historical-token-ohlcv` (`--timeframe` still works), and `--symbol` for a perp market (`perp order/cancel/close/leverage`, and research perp commands now accept `--coin`). Giving one input under two names now fails instead of silently using one of them. `--days` on `token screener`, `info` or `flow-intelligence` now points to `--timeframe`.
