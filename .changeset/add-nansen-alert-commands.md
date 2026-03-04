---
"nansen-cli": minor
---

feat: add `nansen alert` command group for creating and managing smart money alerts

New subcommands: `create`, `list`, `delete`, `toggle`.
Alerts are delivered via Telegram, Slack, or Discord by Nansen's backend when thresholds are crossed.
Help text includes full @NansenBot Telegram setup instructions.
