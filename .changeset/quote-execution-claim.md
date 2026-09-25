---
"nansen-cli": patch
---

`trade execute` claims a quote by renaming it to `<id>.executing.json` before signing, so two concurrent runs of the same quote id cannot both broadcast a swap, and a run that waited at the confirmation prompt re-reads the quote before signing. A run that may have sent a swap without recording it leaves the quote claimed, so a retry is refused rather than broadcast twice
