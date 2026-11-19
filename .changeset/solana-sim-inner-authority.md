---
"nansen-cli": patch
---

Solana swap and limit-order verification now also refuses to sign when the transaction approves a token delegate or changes a token or mint authority with your wallet's signature from inside another program, even if the transaction undoes the visible change before it ends. If a custom `NANSEN_SOLANA_SIM_RPC` does not return inner instructions, verification now refuses with `SIM_INNER_INSTRUCTIONS_UNAVAILABLE`; the default RPC returns them.
