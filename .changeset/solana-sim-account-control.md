---
"nansen-cli": patch
---

Solana swap and limit-order verification now refuses to sign when the simulated transaction would hand control of one of your wallet's token accounts to someone else (a new owner, delegate or close authority), or would lock the wallet itself (reassigned to another program, or given account data), even when every balance looks right. The rent of a closed token account now counts toward the SOL balance check.
