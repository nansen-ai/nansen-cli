---
"nansen-cli": patch
---

`--fields` now supports dotted paths. `--fields data.results.address` selects that field at that position only (array elements do not add a segment), while a bare name such as `--fields address` keeps matching at any depth. Dotted paths were mentioned in the code but matched nothing, so `--fields data.results` returned an empty object.
