---
"nansen-cli": patch
---

A repeated list option whose values are themselves comma-separated (`--tags defi,nft --tags sports`) is now flattened to `defi, nft, sports`. Previously the first value was kept as the literal `defi,nft`, so the same list was read differently depending on whether it was passed once or as repeated flags.
