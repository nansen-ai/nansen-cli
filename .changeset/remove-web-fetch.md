---
"nansen-cli": minor
---

**Removed `nansen web fetch` and the `nansen-web-fetcher` skill.** The Nansen API removed `POST /api/v1/search/web-fetch`, so the command can no longer return results. `nansen web fetch` now fails with the usual unknown-subcommand error listing `search`. There is no replacement command. It is released as a minor rather than a major because the endpoint is gone server-side: no working integration can depend on the command.
