---
"nansen-cli": patch
---

x402 payments skip an option whose chain has no key in the wallet with a clear reason (for example `wallet "main" has no Solana key`) instead of a raw JavaScript error, and the self-sponsored Solana `feePayer` error no longer points only at Base as the alternative.
