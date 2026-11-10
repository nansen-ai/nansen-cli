---
"nansen-cli": patch
---

ENS names now still resolve when the ensideas API is unavailable. The on-chain fallback was pinned to `eth.llamarpc.com`, which answers HTTP 525, so any ensideas outage failed every `.eth` lookup. It now uses the same Ethereum RPC as the rest of the CLI (`NANSEN_EVM_RPC`, or the shared default), and keeps the port and query string of a custom RPC URL.
