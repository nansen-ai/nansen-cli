---
"nansen-cli": patch
---

Telemetry events now list only option names the CLI defines for the command being run (plus global options and built-in switches such as `--help`). Any other name is sent as `--<unknown>`. Previously a value that starts with `-` and is passed as a separate argument, as in `--webhook-secret -abc123`, was parsed as a flag and its text was sent as a flag name.
