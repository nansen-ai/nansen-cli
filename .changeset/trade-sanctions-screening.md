---
"nansen-cli": patch
---

`trade quote` and `trade execute` now screen the signing wallet (and any distinct `--to-wallet` destination) against the compliance blocklist before requesting a quote or signing — the same fail-closed check `bridge` and `perp` already run — so a flagged address, or a screening call that fails, aborts the command before anything is signed or broadcast. Both commands now require API access for this check; authenticate with `nansen login` or `NANSEN_API_KEY` before trading.
