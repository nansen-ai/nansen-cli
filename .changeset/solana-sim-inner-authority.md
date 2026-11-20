---
"nansen-cli": patch
---

Solana swap and limit-order verification now also refuses to sign when the transaction approves a token delegate or changes a token or mint authority with your wallet's signature from inside another program, even if the transaction undoes the visible change before it ends, or when another party hands your wallet an existing token account that could still carry its close authority. If the simulation RPC (`NANSEN_SOLANA_SIM_RPC`, or `NANSEN_SOLANA_RPC` when that isn't set) does not return inner instructions, swaps, bridges and limit-order deposits and cancels now refuse to sign instead of skipping the check; the default RPC returns them.
