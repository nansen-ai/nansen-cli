---
"nansen-cli": patch
---

`trade execute`: accept a capitalised chain name. `trade quote --chain Base` stores the chain exactly as you typed it, but the RPC registry is keyed lowercase, so the quote could be created and then never executed ("No RPC URL configured for chain: Base"). The chain is now normalised once when the quote is loaded, which also fixes quotes already on disk.
