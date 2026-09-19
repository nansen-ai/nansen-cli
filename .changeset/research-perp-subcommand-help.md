---
"nansen-cli": patch
---

Show the real subcommand help for `nansen research perp screener --help` and `nansen research perp leaderboard --help`. Because `perp` is also a top-level trading command, the help lookup stopped at the trading command's subcommand list and fell back to printing the category listing — "Use: nansen research perp <subcommand> --help", the command that had just been run — so the parameters, credit cost and example were unreachable. `nansen perp screener --help` now resolves to the same help, with an example pointing at the `research` path.
