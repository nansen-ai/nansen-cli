---
"nansen-cli": patch
---

Drop `Fund` from the Smart Money label list in `nansen schema`, the examples and the default labels for `--smart-money`. The help text now says `Fund` is no longer a Smart Money label. Fund wallets left the Smart Money cohort on 2026-09-09, so `Fund` matched no wallets there.
