---
"nansen-cli": minor
---

Shorter top-level help. `nansen` and `nansen --help` now print a short index (get-started commands, the command list, and where to find more) instead of 82 lines, and no longer wait on a credit-cost fetch before printing. The detail moved behind `nansen help <topic>` (`auth`, `options`, `examples`, `chains`, `labels`, `deprecated`, `telemetry`). `nansen help <command> [subcommand]` prints the same as `nansen <command> [subcommand] --help`, and `nansen help <unknown>` now fails with `UNKNOWN_COMMAND` instead of printing the full page.
