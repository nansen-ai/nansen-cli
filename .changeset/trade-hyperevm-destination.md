---
"nansen-cli": minor
---

`nansen trade quote --to-chain hyperevm` bridges into HyperEVM, and `nansen trade bridge-status` tracks it. HyperEVM is a destination only: `--chain hyperevm` is refused before any request, because the trading service has no same-chain HyperEVM swaps and the CLI cannot verify a transaction signed there.
