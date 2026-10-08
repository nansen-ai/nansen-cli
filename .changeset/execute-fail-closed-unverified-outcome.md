---
"nansen-cli": patch
---

`trade execute`: never treat an unverified broadcast as "nothing was sent". Once a signed payload has been handed to a wallet or the execute API, an unreadable response, network failure, HTTP error, WalletConnect failure, receipt timeout, or confirmed on-chain revert now stops the command and marks the quote as spent instead of signing the next candidate. HTTP status alone—including 400, 408, 409, and 429—no longer claims that the backend rejected the transaction before broadcast. A Solana success response must also contain a transaction signature or hash; otherwise the outcome fails closed instead of printing a successful transaction with an undefined identifier. The same protection covers WalletConnect swap, approval, and allowance-revoke sends, mismatched hashes, and malformed success responses.
