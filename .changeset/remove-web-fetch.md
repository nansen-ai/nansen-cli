---
"nansen-cli": minor
---

**Removed `nansen web fetch` and the `nansen-web-fetcher` skill.** The Nansen API removed `POST /api/v1/search/web-fetch`, the only endpoint the command called, so it can't return results on any CLI version. `nansen web fetch` now fails with the usual unknown-subcommand error listing `search`. There is no replacement command.

This removes a published subcommand and its `schema.json` entry. It ships as a minor because the server-side removal already breaks the command for every installed version. The earlier points leaderboard route removal (#542) followed the same reasoning.
