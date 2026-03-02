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

## Password Policy (Agents)

> **CRITICAL: Never generate a wallet password at runtime.**

Wallets are encrypted with AES-256-GCM. A lost password means permanently locked funds — there is no recovery mechanism.

- `NANSEN_WALLET_PASSWORD` **must already be set** in the environment before any wallet operation
- If the variable is not set, **ask the user to configure it** — do not generate, hardcode, or suggest a password
- Never store or echo the password in conversation history

```bash
# Check before any wallet operation
if [ -z "$NANSEN_WALLET_PASSWORD" ]; then
  echo "NANSEN_WALLET_PASSWORD is not set. Please configure it before proceeding."
  exit 1
fi
```

**User instructions:** Set the env var in your shell profile or agent runtime config:
```bash
export NANSEN_WALLET_PASSWORD="<your-password>"
```

## Create

```bash
# Assumes NANSEN_WALLET_PASSWORD is already set (see Password Policy above)
nansen wallet create
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
| `NANSEN_WALLET_PASSWORD` | **Required for agents.** Wallet encryption password — must be pre-configured, never generated at runtime (see Password Policy) |
| `NANSEN_API_KEY` | API key (also set via `nansen login`) |
| `NANSEN_EVM_RPC` | Custom EVM RPC endpoint |
| `NANSEN_SOLANA_RPC` | Custom Solana RPC endpoint |
