---
"nansen-cli": patch
---

Fix `nansen changelog` always showing "CHANGELOG.md not found". Added a `files` field to `package.json` to explicitly bundle `CHANGELOG.md` with the published package. Also excludes `src/__tests__/` from the package, reducing package size from ~537 kB to ~269 kB.
