---
"nansen-cli": patch
---

`wallet send` on Solana no longer tells you to top up your wallet when a SOL send fails because the recipient would hold less than the rent-exempt minimum. Solana rejects a transfer that leaves a new address below about 0.00089 SOL, naming that account by its index; any account other than your wallet now gets an error that says so and gives the minimum, instead of the insufficient-balance advice meant for the wallet itself.
