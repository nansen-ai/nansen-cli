---
"nansen-cli": patch
---

Make every wallet subcommand discoverable from the places agents look first. `nansen --help` now lists `send`, `forget-password` and `secure` on the wallet line (previously only seven of the nine were shown) and the full perp subcommand set (`transfer`, `approve-builder-fee`, `orders`, `account`, `meta`, `screener` and `leaderboard` were missing). It also stops describing the combined top-level `perp` command as a deprecated analytics alias. README lists the same wallet set, and `nansen schema wallet` now documents `forget-password` and `secure` with descriptions plus an example for every wallet subcommand. Help text, README, runtime command help and schema are pinned together by a new drift-guard test.
