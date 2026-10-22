---
"nansen-cli": patch
---

Serialize wallet create, default, and delete mutations across processes so concurrent commands cannot strand wallets or leave stale configuration.
