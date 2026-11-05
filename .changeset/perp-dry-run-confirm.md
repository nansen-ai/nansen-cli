---
"nansen-cli": minor
---

`perp order`, `perp close`, `perp cancel` and `perp leverage` now accept `--dry-run`, which runs the normal validation, prints the plan (coin, side, rounded size, price and type, estimated notional, leverage, builder fee) and exits 0 without signing or submitting anything. No wallet password is needed for a dry run, and the one-time builder-fee approval is not submitted.

These four commands now ask for confirmation before signing when stdin is an interactive terminal, the same way `trade execute` and `bridge execute` do. Answering anything but `y` exits 1 with nothing signed. `--yes`, `-y` or `NANSEN_YES=1` skips the question. **Scripts and agents whose stdin is not a terminal (pipes, CI, agent shells) see no change:** the commands submit without asking, as before, and `--yes` is a no-op there. A script that runs these commands from an interactive terminal, or an agent that runs them under a pseudo-terminal, will now be asked; add `--yes` or set `NANSEN_YES=1` to keep the old behaviour.
