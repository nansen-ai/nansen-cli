---
"nansen-cli": patch
---

Solana SPL sends no longer report a rate limit, network failure or malformed RPC reply as "Source token account not found". Only a missing token account gives that message; other failures say the balance could not be read. `--max` SPL sends report a missing token account the same way.
