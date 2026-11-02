---
"nansen-cli": minor
---

`nansen alerts create` and `nansen alerts update` accept the webhook signing secret from `--webhook-secret-stdin` (pipe or redirected file) or the `NANSEN_WEBHOOK_SECRET` environment variable, so it no longer has to appear on the command line, in shell history or in the process list. `--webhook-secret` still works; it cannot be combined with `--webhook-secret-stdin`, and either flag overrides the environment variable, which is read only when `--webhook` is given. `--webhook-secret` with no value or an empty value is now rejected instead of being silently ignored.
