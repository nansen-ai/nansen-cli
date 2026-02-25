# AGENTS.md

Guidance for AI coding agents working on this repository.

## Overview

nansen-cli is an open-source Node.js CLI for the [Nansen](https://nansen.ai) blockchain analytics API. Designed for AI agents to query onchain data, manage wallets, trade tokens, and make x402 micropayments.

## Architecture

```
src/
├── index.js          # Entry point (shebang, calls runCLI)
├── cli.js            # Command router, arg parsing, schema, help text
├── api.js            # NansenAPI client (REST, retry, cache, x402 auto-pay)
├── wallet.js         # Wallet CRUD (create/list/show/export/delete/send)
├── trading.js        # Quote + execute swaps (OKX router via API)
├── transfer.js       # Token/native transfers (EVM + Solana)
├── x402.js           # x402 payment orchestration (picks network, signs)
├── x402-evm.js       # EVM payment signing (EIP-3009 transferWithAuthorization)
├── x402-svm.js       # Solana payment signing (SPL transfer)
├── crypto.js         # Key encryption/decryption (AES-256-GCM or plaintext)
└── update-check.js   # Version upgrade notice
```

### Key patterns

- **Entry**: `src/index.js` → `runCLI()` in `src/cli.js`
- **Commands**: Built by `buildCommands()` (cli.js), `buildWalletCommands()` (wallet.js), `buildTradingCommands()` (trading.js). Merged in `runCLI()`.
- **Auth flow**: Commands in `NO_AUTH_COMMANDS` skip API init. Everything else instantiates `NansenAPI` with retry/cache/x402 config.
- **Output**: Core functions return data objects. CLI layer formats via `formatOutput()`. Never `console.log` in core functions.
- **Wallet security**: Passwords optional. Without `NANSEN_WALLET_PASSWORD`, keys stored as plaintext (like SSH keys). With it, AES-256-GCM encrypted.
- **x402 auto-pay**: When API returns 402, `api.js` calls `createPaymentSignatures()` which yields signatures (EVM first, then Solana fallback). Retry loop tries each until one succeeds.

### Data flow for a trade

```
CLI (quote args) → api.js (GET /defi/quote) → response
CLI (execute)    → wallet.js (decrypt key) → trading.js (sign tx) → api.js (POST /defi/execute) → broadcast
```

### Data flow for x402 payment

```
api.js (any call) → 402 response with payment requirements
  → x402.js rankRequirements() → picks cheapest network
  → x402-evm.js or x402-svm.js → sign payment
  → api.js retries original request with Payment-Signature header
```

## Commands

| Command | Subcommands | Auth required |
|---------|-------------|---------------|
| `login` | — | No |
| `logout` | — | No |
| `wallet` | create, list, show, export, default, delete, send | No |
| `smart-money` | — | Yes |
| `profiler` | balance, labels, search | Yes |
| `token` | holders, screener | Yes |
| `portfolio` | — | Yes |
| `perp` | — | Yes |
| `search` | — | Yes |
| `points` | — | Yes |
| `quote` | — | Yes |
| `execute` | — | Yes |
| `schema` | — | No |
| `cache` | — | No |
| `help` | — | No |
| `changelog` | — | No |

## Development

```bash
npm install           # Install dependencies
npm test              # Run tests (vitest)
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

### Running locally

```bash
node src/index.js <command> [options]

# Examples
node src/index.js wallet create my-wallet
node src/index.js smart-money --chain solana --limit 5
node src/index.js token holders --token 0x... --smart-money
```

## Testing

- **Framework**: Vitest
- **Test files**: `src/__tests__/*.test.js`
- **Current**: 577 tests across 13 files, all passing
- **All new code MUST have tests**
- **Mock RPC/API calls** — never hit real networks or Nansen API in tests
- RPC mocks: use `vi.fn()` to mock `fetch` and return canned JSON-RPC responses
- Match on method name (`eth_getBalance`, `getBalance`, `getTokenAccountsByOwner`, etc.)
- Include all RPC methods your code path touches (e.g., `eth_getCode`, `eth_getTransactionReceipt`, `eth_maxPriorityFeePerGas` for EVM transfers)

### Test structure

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
global.fetch = vi.fn();

describe('featureName', () => {
  beforeEach(() => {
    fetch.mockReset();
    // Set up default mocks
  });

  it('should do the thing', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', result: '0x...', id: 1 })
    });
    // test logic
  });
});
```

### Common mock patterns

**EVM transfers** need mocks for: `eth_getBalance`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getTransactionCount`, `eth_estimateGas`, `eth_getCode`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`

**Solana transfers** need mocks for: `getBalance`, `getLatestBlockhash`, `sendTransaction`, `getSignatureStatuses`

**SPL token transfers** additionally need: `getTokenAccountsByOwner`, `getAccountInfo`

## Style Guide

- **ESM** (`import`/`export`), no TypeScript, no transpilation
- **No interactive prompts** in core functions — use env vars (`NANSEN_WALLET_PASSWORD`, `NANSEN_API_KEY`)
- **Error handling**: `throw new Error('descriptive message')` in core. CLI catches and formats.
- **Error messages must be actionable** — tell the user what to do, not just what went wrong
  - ❌ `"Authentication failed"`
  - ✅ `"Not logged in. Run: nansen login"`
- **BigInt for amounts** — never use floating point for token amounts. Parse to BigInt with decimals.
- **Chain-specific code**: Use `chain === 'solana'` branching, not inheritance
- **No unnecessary dependencies** — stdlib and built-in Node.js APIs preferred

## PR Checklist

Before submitting a PR:

- [ ] `npm test` passes (all 577+ tests)
- [ ] New code paths have test coverage
- [ ] No hardcoded secrets, API keys, or private keys
- [ ] No `console.log` in core functions (use the `log` dep injection)
- [ ] Error messages are actionable
- [ ] CLI help text updated if adding/changing commands
- [ ] RPC mocks cover all methods in the code path
- [ ] Wallet flows work with AND without password (`NANSEN_WALLET_PASSWORD`)

## Chains & Networks

**EVM**: Ethereum (chain ID 1), Base (8453). Transfer support limited to these two in `CHAIN_IDS` map.

**Solana**: mainnet-beta. Supports native SOL, standard SPL tokens, and Token-2022 (Token Extensions).

**RPC endpoints**: Hardcoded in `CHAIN_RPCS` (transfer.js). Nansen API handles RPC for trading.

## Key Constants

- **USDC (Base)**: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **USDC (Solana)**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **x402 payment**: $0.05 USDC per API call, facilitator settles on Solana
- **Gas**: API provides `quote.gas` with 1.5x buffer — use it directly, no client-side estimation needed for trades

## Known Gotchas

1. **EIP-7702 delegated accounts** on Base have contract code. `eth_estimateGas` must be used (not hardcoded 21000 gas).
2. **Solana SPL account ordering**: Writable accounts (destATA) must precede readonly (mint) in the transaction message.
3. **`getSignatureStatuses`** over `confirmTransaction` — the latter is deprecated and unreliable on public RPCs.
4. **`--max` native SOL**: Reserve 5000 lamports for fee. On EVM L2s, reserve 3x estimated gas for L1 data posting.
5. **Token-2022**: Use `TOKEN_2022_PROGRAM_ID` and `TransferCheckedInstruction` (not plain `Transfer`).
6. **CreateATA path**: When recipient doesn't have a token account, the sender must create it. This path exists in transfer.js but has limited test coverage.
