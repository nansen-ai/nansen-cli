---
name: nansen-wallet-send
description: Send native tokens (SOL, ETH) from a nansen-cli wallet. Use when transferring funds. Password auto-resolved from keychain — no env var needed after wallet creation.
---

# Wallet Send

Password is auto-resolved from OS keychain after initial `wallet create`. No env var needed.

```bash
# Send a specific amount (native token: SOL on solana, ETH on base/evm)
nansen wallet send --to <addr> --amount 1.5 --chain solana

# Send entire balance
nansen wallet send --to <addr> --chain evm --max

# Dry run — preview without broadcasting
nansen wallet send --to <addr> --amount 1.0 --chain evm --dry-run
```

| Flag | Purpose |
|------|---------|
| `--to` | Recipient address |
| `--amount` | Amount in human units (e.g. 1.5 SOL) |
| `--chain` | `evm` or `solana` |
| `--max` | Send entire balance |
| `--dry-run` | Preview without broadcasting |
| `--wallet` | Wallet name (default: default wallet) |

For ERC-20 token swaps, use `nansen-trade` instead.
If you get `PASSWORD_REQUIRED`, follow `nansen-wallet-migration` to restore keychain access.
