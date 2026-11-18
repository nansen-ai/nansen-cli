---
"nansen-cli": patch
---

Solana swap and limit-order verification now refuses to sign when the simulated transaction would hand control of one of your wallet's accounts to someone else (a new token-account owner, delegate or close authority, a closed empty token account, a delegate, authority change or account close made from inside another program with your wallet's signature (or a close of one of your token accounts, by any authority, that does not send its rent back to your wallet), or the wallet reassigned to another program), even when every balance looks right.
