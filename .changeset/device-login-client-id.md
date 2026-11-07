---
"nansen-cli": patch
---

`nansen login` now identifies itself as the `nansen-cli` client during browser approval, so API usage from browser sessions can be attributed to the CLI. Sessions from earlier logins keep working unchanged; run `nansen login` again to pick it up.
