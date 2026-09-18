---
"nansen-cli": patch
---

Resolve ENS names when the profiler chain is `all`. The profiler commands default `--chain` to `all`, but the resolver only accepted explicit EVM chains, so `research profiler labels --address vitalik.eth` (and every other profiler subcommand except `first-funder`) failed with `ENS names can only be resolved on EVM chains, not all` unless `--chain ethereum` was passed.
