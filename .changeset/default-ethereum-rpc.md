---
"nansen-cli": patch
---

Fix `wallet send --chain ethereum` (and `--chain evm`) failing with "Unauthorized: You must authenticate your request with an API key": the default Ethereum RPC now requires a key, so the CLI uses `https://ethereum-rpc.publicnode.com` instead. `NANSEN_EVM_RPC` still overrides it.
