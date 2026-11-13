---
"nansen-cli": patch
---

`nansen alerts create` and `update` no longer offer the `smart-contract-call` alert type, which the Nansen API retired and now rejects. Passing `--type smart-contract-call`, or one of the flags only that type used (`--signature-hash`, `--caller`, `--contract`, `--exclude-caller`, `--exclude-contract`), now fails with an `INVALID_PARAMS` error that says the type was retired, before any request is sent. An unknown `--type` value is rejected the same way, with the valid types listed. `nansen schema` now lists the valid `--type` values as an enum.
