---
"nansen-cli": patch
---

`nansen alerts` now redacts channel credentials (Slack, Discord and webhook URLs, webhook signing secrets) in its output and error messages by default. Pass `--reveal` to show the full values; scripts that read `channels[].data` values from `nansen alerts` output need it.
