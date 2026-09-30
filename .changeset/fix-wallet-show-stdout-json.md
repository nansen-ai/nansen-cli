---
"nansen-cli": minor
---

`nansen wallet show <name>` now prints the standard JSON envelope on stdout, `{"success":true,"data":{"name":...,"provider":...,"evm":...,"solana":...,"createdAt":...,"isDefault":...}}`, so `nansen wallet show main | jq .` works and `--pretty`, `--table`, `--format csv` and `--fields` apply to it. Privy wallets also include `privyWalletIds`. The redacted default of `nansen wallet export <name>` does the same, returning `{"name":...,"redacted":true,"evm":{"address":...},"solana":{"address":...}}` with no key fields. Both previously printed a readable summary that agents could not parse. `wallet export --reveal` and `--file` are unchanged.
