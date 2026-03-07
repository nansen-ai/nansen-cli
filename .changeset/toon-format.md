---
"nansen-cli": minor
---

Add `--format toon` output format — a compact, token-efficient encoding for AI agents. Uniform arrays render as CSV-with-header; objects as YAML-style key-value; nested structures fall back gracefully. ~74% token reduction vs pretty-printed JSON on typical array responses.
