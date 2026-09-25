---
name: nansen-wallet-manager
description: Wallet management — create (local or Privy server-side), list, show, export, send, delete. Use when creating wallets, checking balances, or sending tokens.
metadata:
  openclaw:
    requires:
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---
## Authentication

Nansen account API calls accept a selected `nansen:api` browser session or conventional API key with the same permissions. `NANSEN_API_KEY` takes precedence; optional `primaryEnv` preserves configured-key injection. Run `nansen auth status` for offline selection. Cached access expiry alone permits automatic renewal during an authorized task. Stop on anonymous selection, invalid state, blocked/uncertain renewal or actual auth failure; never drop a credential or fall back to anonymous x402 payment. Browser login does not grant wallet signing, privileged service identity or a persistent MCP integration key. Preserve all confirmation, signing, sanctions and geographic checks below. Browser rollout acceptance is still pending.



# Wallet

## Auth Setup

Use a selected nansen:api browser session or conventional API key for Nansen account API calls. Agents should inject `NANSEN_API_KEY` through their environment or secret manager and use commands directly; no login is needed to persist it. Human terminal users can use explicit `nansen login --human` for legacy key setup. With an already injected environment key, that explicit mode saves it without prompting and requires the native auth lock binding.

```bash
# Free live check of the effective API credential
nansen account
```

Plain `nansen login` instead requests fresh browser approval. It does not save an environment key or grant wallet signing/RPC authority. Wallet custody and provider credentials below remain separate.

## Wallet Providers

The CLI supports two wallet providers:

| | **Local** (default) | **Privy** (server-side) |
|---|---|---|
| Key storage | Encrypted on disk | Server-side via Privy API |
| Password required | Yes (min 12 chars) | No |
| Export private keys | Yes (`wallet export`) | No — keys are managed by Privy |
| Best for | Human users, manual trading | Agents, automated workflows |
| Flag | `--provider local` (default) | `--provider privy` |
| Required env vars | `NANSEN_WALLET_PASSWORD` | `PRIVY_APP_ID` + `PRIVY_APP_SECRET` |

## Privy Wallet Creation

Privy wallets are server-side wallets managed by the Privy API. No password is needed — keys never touch the local machine.

### Prerequisites

The following environment variables must be set:

| Var | Purpose |
|-----|---------|
| `PRIVY_APP_ID` | Privy application ID |
| `PRIVY_APP_SECRET` | Privy application secret |

### Create a Privy wallet

```bash
nansen wallet create --provider privy
# Or with a custom name:
nansen wallet create --name agent-wallet --provider privy
```

### Critical rules for agents (Privy)

- **No password needed** — Privy manages keys server-side
- **Cannot export keys** — `wallet export` only works for local wallets
- All other operations (`list`, `show`, `send`, `delete`, `default`) work identically for both providers

## Local Wallet Creation (Two-Step Agent Flow)

> This section covers **local** wallet creation. For Privy server-side wallets, see the [Privy Wallet Creation](#privy-wallet-creation) section above — no password is needed.

Wallet creation requires a password from the **human user**. The agent must NOT generate or store the password itself.

> **Step 1 (Agent → Human):** Ask the user to provide a wallet password (minimum 12 characters).
>
> **Step 2 (Agent executes):** Run the create command with the password the user gave you.

```bash
NANSEN_WALLET_PASSWORD="<password_from_user>" nansen wallet create
```

After creation, the CLI automatically saves the password:
- **OS keychain** (macOS Keychain, Linux secret-tool, Windows Credential Manager) — secure, preferred
- **~/.nansen/wallets/.credentials file** — insecure fallback when no keychain is available (e.g. containers, CI)

**All future wallet operations retrieve the password automatically** — no env var or human input needed.

If the `.credentials` file fallback is used, the CLI prints a warning on every operation. To migrate to secure storage later, run `nansen wallet secure`.

### Password resolution order (automatic)

1. `NANSEN_WALLET_PASSWORD` env var (if set)
2. OS keychain (saved automatically on wallet create)
3. `~/.nansen/wallets/.credentials` file (insecure fallback, with warning)
4. Structured JSON error with instructions (if none available)

### Critical rules for agents

- **NEVER generate a password yourself** — always ask the human user
- **NEVER store the password** in files, memory, logs, or conversation history
- **NEVER use `--human` flag** — that enables interactive prompts which agents cannot handle
- After wallet creation, you do NOT need the password for future operations — the keychain handles it
- If you get a `PASSWORD_REQUIRED` error, ask the user to provide their password again

## Create

### Privy (server-side, no password)

```bash
nansen wallet create --provider privy
# Or with a custom name:
nansen wallet create --name trading --provider privy
```

Requires `PRIVY_APP_ID` + `PRIVY_APP_SECRET` env vars. No password needed.

### Local (encrypted on disk, password required)

```bash
# Ask the user for a password first, then:
NANSEN_WALLET_PASSWORD="<password_from_user>" nansen wallet create
# Or with a custom name:
NANSEN_WALLET_PASSWORD="<password_from_user>" nansen wallet create --name trading
```

## List & Show

```bash
nansen wallet list
nansen wallet show <name>
nansen wallet default <name>
```

## Send

```bash
# Send native token (SOL, ETH) — password auto-resolved from keychain
nansen wallet send --to <addr> --amount 1.5 --chain solana

# Send entire balance
nansen wallet send --to <addr> --chain evm --max

# Dry run (preview, no broadcast)
nansen wallet send --to <addr> --amount 1.0 --chain evm --dry-run
```

## Export & Delete

```bash
# Default is REDACTED — shows addresses only, never private keys
nansen wallet export <name>

# Write private keys to a file only the owner can read (0600, refuses to overwrite)
nansen wallet export <name> --file <path>

# Print private keys in plaintext to stdout (explicit acknowledgement required;
# warns on stderr when stdout is an interactive terminal)
nansen wallet export <name> --reveal

# Password auto-resolved from keychain (needed for --reveal / --file)
nansen wallet delete <name>
```

Prefer `--file` over `--reveal`: plaintext on stdout ends up in terminal
scrollback, shell logs, and agent transcripts.

## Forget Password

```bash
# Remove saved password from all stores (keychain + .credentials file)
nansen wallet forget-password
```

## Migrate to Secure Storage

```bash
nansen wallet secure
```

For detailed migration steps (from `~/.nansen/.env`, `.credentials`, or env-var-only setups), see the **nansen-wallet-migration** skill.

## Flags

| Flag | Purpose |
|------|---------|
| `--to` | Recipient address |
| `--amount` | Amount to send |
| `--chain` | `evm` or `solana` |
| `--max` | Send entire balance |
| `--dry-run` | Preview without broadcasting |
| `--provider` | Wallet provider: `local` (default, encrypted on disk) or `privy` (server-side via Privy API) |
| `--reveal` | Export only: print private keys in plaintext to stdout (required acknowledgement) |
| `--file` | Export only: write private keys to this path (created 0600, refuses to overwrite) |
| `--human` | Enable interactive prompts (human terminal use only — agents must NOT use this) |
| `--unsafe-no-password` | Skip encryption (keys stored in plaintext — NOT recommended) |

## Environment Variables

| Var | Purpose |
|-----|---------|
| `NANSEN_WALLET_PASSWORD` | Wallet encryption password — only needed for initial `wallet create`. After that, the OS keychain handles it. |
| `NANSEN_API_KEY` | API key (can also be saved via `nansen login --human`) |
| `PRIVY_APP_ID` | Privy application ID (required for `--provider privy`) |
| `PRIVY_APP_SECRET` | Privy application secret (required for `--provider privy`) |
| `NANSEN_WALLET_PROVIDER` | Default provider for wallet create — `local` or `privy` |
| `NANSEN_EVM_RPC` | Custom EVM RPC endpoint |
| `NANSEN_SOLANA_RPC` | Custom Solana RPC endpoint |
