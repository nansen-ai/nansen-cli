---
name: nansen-wallet
description: Wallet management — create, list, show, export, send, delete. Use when creating wallets, checking balances, or sending tokens.
allowed-tools: Bash
---

# Wallet

## Auth Setup

```bash
# API key (persistent — recommended)
nansen login
# Or non-interactive:
NANSEN_API_KEY=<key> nansen login

# Verify
nansen research profiler labels --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum
```

## Create

```bash
# Interactive
nansen wallet create

# Non-interactive (for agents/CI)
NANSEN_WALLET_PASSWORD="<password>" nansen wallet create
```

## List & Show

```bash
nansen wallet list
nansen wallet show <name>
nansen wallet default <name>
```

## Send

```bash
# Send native token (SOL, ETH)
nansen wallet send --to <addr> --amount 1.5 --chain solana

# Send entire balance
nansen wallet send --to <addr> --chain evm --max

# Dry run (preview, no broadcast)
nansen wallet send --to <addr> --amount 1.0 --chain evm --dry-run
```

## Export & Delete

```bash
nansen wallet export <name>
nansen wallet delete <name>
```

## Flags

| Flag | Purpose |
|------|---------|
| `--to` | Recipient address |
| `--amount` | Amount to send |
| `--chain` | `evm` or `solana` |
| `--max` | Send entire balance |
| `--dry-run` | Preview without broadcasting |

## Environment Variables

| Var | Purpose |
|-----|---------|
| `NANSEN_WALLET_PASSWORD` | Skip interactive password prompt |
| `NANSEN_API_KEY` | API key (also set via `nansen login`) |
| `NANSEN_EVM_RPC` | Custom EVM RPC endpoint |
| `NANSEN_SOLANA_RPC` | Custom Solana RPC endpoint |
