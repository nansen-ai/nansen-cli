---
name: nansen-wallet-manage
description: List, inspect, export, delete, and secure nansen-cli wallets. Use when checking which wallets exist, exporting keys, or maintaining password storage.
---

# Wallet Manage

```bash
# List all wallets
nansen wallet list

# Inspect a wallet (addresses only — does NOT load password)
nansen wallet show <name>
nansen wallet show default

# Set default wallet
nansen wallet default <name>

# Export private keys (password auto-resolved from keychain)
nansen wallet export <name>

# Delete a wallet
nansen wallet delete <name>

# Remove saved password from all stores (keychain + .credentials)
nansen wallet forget-password

# Migrate insecure password to OS keychain
nansen wallet secure
```

`wallet show` never loads the password — use `wallet export` to prove decryption works.
If `export` shows `Incorrect password`, run `wallet forget-password` then re-run `wallet secure`.
For full migration scenarios (old .env files, lost passwords), use `nansen-wallet-migration`.
