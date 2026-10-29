---
"nansen-cli": patch
---

Wallet create, default and delete now wait for each other instead of racing. Two overlapping first `wallet create` runs with different passwords could both report success while leaving one wallet impossible to unlock.
