---
"nansen-cli": patch
---

`trade execute`: treat every `/execute` response this client cannot interpret as an ambiguous broadcast instead of a pre-broadcast rejection. HTTP status alone — including 400, 408, 409 and 429 — no longer claims the backend rejected the transaction before broadcast, a 2xx body that is unreadable or carries no documented `Success`/`Failed` status now fails closed, and a success response must carry a usable transaction identifier on Solana and on gasless EVM. Previously these shapes let the candidate loop sign and broadcast the next quote on top of a transaction that may already be live.

A success or failure response carrying a malformed identifier — an object, a non-string, a non-base58 Solana signature, or a hash that is not 32 bytes of hex — is also refused, instead of reaching the explorer URL, the stored broadcast marker and receipt polling as a value that identifies nothing. EVM paths no longer read Solana's `signature` field at all.
