---
"nansen-cli": minor
---

`nansen trade` now supports Robinhood Chain (`--chain robinhood`), with USDG as its stablecoin anchor. Swap-outcome verification runs on its public RPC (override with `NANSEN_ROBINHOOD_SIM_RPC`, and the RPC itself with `NANSEN_ROBINHOOD_RPC`). The trading service refuses Robinhood Chain trades from some regions. Token addresses on robinhood are now checked for the 0x format. As on Arbitrum and Polygon, a sell that needs a token approval is refused before anything is signed.
