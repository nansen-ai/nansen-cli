---
"nansen-cli": patch
---

Telemetry events no longer include positional values in the command path. `nansen search vitalik.eth` was reported as `/search/vitalik.eth` and `nansen 0x…` as `/0x…`; only command and subcommand names the CLI defines are sent now, and an unknown command is reported as `unknown`.
