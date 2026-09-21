---
"nansen-cli": minor
---

Show the real subcommand help for `nansen research perp screener --help` and `nansen research perp leaderboard --help`. Because `perp` is also a top-level trading command, the help lookup stopped at the trading command's subcommand list and fell back to printing the category listing — "Use: nansen research perp <subcommand> --help", the command that had just been run — so the parameters, credit cost and example were unreachable. `nansen perp screener --help` now resolves to the same help, with an example pointing at the `research` path. Boolean options now accept `--flag=false` and reject invalid or repeated values instead of silently falling back to the server default; value-taking options also accept the conventional `--key=value` spelling, while valueless switches reject inline values instead of creating unusable stale flags. Invalid `changelog --since` values now return a structured error and a non-zero exit status.

The stricter validation intentionally rejects invalid, previously undocumented inputs that only appeared to succeed while being ignored; relying on that quiet fallback was relying on a bug, so this is classified as a minor change rather than a major breaking release.
