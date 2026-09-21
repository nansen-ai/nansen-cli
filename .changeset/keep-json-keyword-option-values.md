---
"nansen-cli": patch
---

Option values that spell a JSON keyword (`--sort true`, `--search false`, `--label null`) are now kept as the literal strings `true`/`false`/`null` instead of being converted to a boolean or null, so string options no longer crash or silently drop the value; `--filters '{}'` and `--order-by '[...]'` still parse as JSON, and `--sort` now rejects a repeated or non-text value with `--sort must be "field" or "field:direction"`.
