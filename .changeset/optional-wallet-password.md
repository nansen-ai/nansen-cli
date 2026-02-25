---
"nansen-cli": minor
---

Make wallet password optional for agent-friendly usage. When `NANSEN_WALLET_PASSWORD` is not set, private keys are stored unencrypted with a warning. Existing encrypted wallets continue to require the password.
