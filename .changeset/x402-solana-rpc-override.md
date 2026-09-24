---
"nansen-cli": patch
---

x402 Solana payments honour `NANSEN_SOLANA_RPC` for blockhash and balance calls instead of always using the public mainnet endpoint. The blockhash fetch also rejects a malformed RPC URL up front without echoing it (private RPC URLs often embed an API key), times out after 15s so a hanging endpoint no longer stalls payment fallback, and defaults to the shared RPC registry rather than a hardcoded public endpoint.
