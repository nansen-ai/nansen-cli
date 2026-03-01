---
"nansen-cli": patch
---

Fix `nansen login --help` to show usage instead of erroring. Previously, `--help` was silently ignored on TTY (showing the interactive prompt) and caused an error on non-TTY. Also fixes the post-login suggested command to use the non-deprecated `nansen research token screener` path.
