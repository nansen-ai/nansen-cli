---
"nansen-cli": minor
---

`nansen trade quote`, `execute` and `bridge-status` now support Ethereum, Arbitrum and Polygon, in addition to Solana and Base. Swap-outcome verification runs on those chains through their public RPC (override with `NANSEN_ETHEREUM_SIM_RPC`, `NANSEN_ARBITRUM_SIM_RPC`, `NANSEN_POLYGON_SIM_RPC`). A swap's anchor side may now be any stablecoin the chain lists (USDC, or USDT where listed, including Solana USDT), not only USDC. Ethereum USDT allowances are reset to 0 before a new approval, as the token requires. The default Polygon RPC moved from polygon-rpc.com, which now refuses anonymous calls, to publicnode. On Arbitrum and Polygon, `trade execute` can't send a token approval yet: a sell that needs one (or a revoke of an oversized allowance first) is refused before anything is signed. Native-token sells, and sells of a token already approved for the swap, work.
