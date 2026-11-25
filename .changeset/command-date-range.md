---
"nansen-cli": minor
---

Research commands that take `--days` now report the date window they used as `_meta.dateRange: { from, to, days, defaulted }` in JSON output. `defaulted` is `true` when neither `--days` nor `--date` was given, so a response that used the default window says so. With `--date`, `days` is `null`. `chain-rank` and `smart-money-pnl-leaderboard` send only a day count, so their `from` and `to` are `null`. `--fields`, `--stream`, `--table` and CSV output are unchanged.
