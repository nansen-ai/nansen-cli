---
"nansen-cli": patch
---

The update notice and `nansen doctor` now say when the latest release needs a newer Node.js than the one running, instead of suggesting `npm i -g nansen-cli`, which npm resolves back to the installed version on an older Node.
