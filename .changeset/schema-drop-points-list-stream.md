---
"nansen-cli": patch
---

`nansen schema` no longer lists `research points leaderboard`, whose endpoint was removed, and now lists `--stream` (NDJSON output, alias `-s`) under global options. The points command is also left out of `nansen research` help and "did you mean" suggestions. Calling it, including with `--help`, still returns `COMMAND_UNAVAILABLE`.
