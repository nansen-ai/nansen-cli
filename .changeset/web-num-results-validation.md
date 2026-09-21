---
"nansen-cli": patch
---

`web search --num-results` now rejects a malformed value (`5abc`, `2.5`, `abc`, a repeated or valueless flag) with `INVALID_PARAMS`. Previously `5abc` was silently truncated to 5, `2.5` to 2, and a non-numeric value fell back to the API default instead of reporting the mistake.
