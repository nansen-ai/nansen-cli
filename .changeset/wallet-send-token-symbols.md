---
"nansen-cli": patch
---

`wallet send --token` now accepts `USDC` and `USDT` on every chain it supports (`evm`/`ethereum`, `base`, `solana`) instead of failing with "Invalid params", and rejects any other non-address value with the accepted symbols. `wallet create --help`, `wallet send --help` and `nansen schema` now list every option (`--name`, `--provider`, `--human`, `--token`, `--wallet`, `--dry-run`) and explain that `wallet create` reads the password from `NANSEN_WALLET_PASSWORD` (it prompts only with `--human`) and saves it to the OS keychain or the `.credentials` fallback.
