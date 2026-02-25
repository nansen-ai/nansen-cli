---
"nansen-cli": minor
---

Add ENS name resolution for profiler commands. Use `.eth` names directly in `--address` flags — resolved automatically via ensideas API with onchain RPC fallback. Works across all profiler subcommands, batch, and trace operations.
