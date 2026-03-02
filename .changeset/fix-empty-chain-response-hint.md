---
"nansen-cli": patch
---

fix: add hint to empty smart-money responses when chain may be unsupported

When `nansen research smart-money netflow --chain monad` (or any chain not yet supported by a specific endpoint) returns an empty data array, the response was indistinguishable from "no activity found". Adds a `_hint` field to empty responses and a `notes` entry to the schema so agents have a clear signal to try a different chain.
