---
"nansen-cli": patch
---

Sync the `chains` list reported by `nansen schema` (and mirrored in `--help` and the README) with the chains the Nansen API actually accepts. Drops `scroll` and `ronin`, which no endpoint serves any more, and adds the chains that were missing: `algorand`, `aptos`, `arc`, `bitcoin`, `bitlayer`, `chiliz`, `citrea`, `gravity`, `hyperliquid`, `injective`, `mantra`, `near`, `robinhood`, `stacks`, `starknet`, `stellar`, `sui`, `ton`, `tron`, `viction`. Not every chain is served by every endpoint; the API still validates `--chain` per endpoint.
