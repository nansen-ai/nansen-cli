---
"nansen-cli": patch
---

Make every wallet subcommand discoverable from the places agents look first. `nansen --help` now lists `send`, `forget-password` and `secure` on the wallet line (previously only seven of the nine were shown) and the full perp subcommand set (`transfer`, `approve-builder-fee`, `orders`, `account`, `meta` were missing). README lists the same wallet set, and `nansen schema wallet` now documents `forget-password` and `secure` with descriptions plus an example for every wallet subcommand. Help text, README and schema are pinned to the real command surface by a new drift-guard test.
