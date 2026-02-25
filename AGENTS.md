# AGENTS.md — Contributor Guide

Guidance for AI coding agents (Claude Code, Codex, Copilot, etc.) working on this repository. If you're an agent **using** the CLI, see [README.md](README.md).

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

### Command routing

`src/index.js` → `runCLI()` in `src/cli.js`

Commands are built by three functions, merged in `runCLI()`:
- `buildCommands()` in cli.js — analytics commands (smart-money, profiler, token, etc.)
- `buildWalletCommands()` in wallet.js — wallet subcommands
- `buildTradingCommands()` in trading.js — quote/execute

Commands listed in `NO_AUTH_COMMANDS` skip API initialization. Everything else instantiates `NansenAPI` with retry, cache, and x402 config.

### Data flow: trade

```
CLI args → api.js GET /defi/quote → quote response
         → wallet.js decrypt key → trading.js sign tx → api.js POST /defi/execute → broadcast
```

### Data flow: x402 auto-pay

```
api.js (any call) → 402 response with payment requirements
→ x402.js rankRequirements() → picks cheapest network (EVM first)
→ x402-evm.js or x402-svm.js → sign USDC payment
→ api.js retries original request with Payment-Signature header
```

If EVM payment fails (insufficient funds), the async generator yields a Solana signature as fallback.

### Output convention

Core functions return data objects. The CLI layer formats via `formatOutput()`. Never `console.log` in core functions — use the `log` dependency injection for CLI output.

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
```

## Testing

- **Framework:** Vitest
- **Test files:** `src/__tests__/*.test.js`
- **Current:** 577 tests across 13 test files
- **All new code must have tests**
- **Mock all RPC/API calls** — never hit real networks in tests

### Test structure

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

global.fetch = vi.fn();

describe('featureName', () => {
  beforeEach(() => {
    fetch.mockReset();
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

### Required RPC mocks by code path

**EVM transfers:** `eth_getBalance`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getTransactionCount`, `eth_estimateGas`, `eth_getCode`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`

**Solana transfers:** `getBalance`, `getLatestBlockhash`, `sendTransaction`, `getSignatureStatuses`

**SPL token transfers** (additionally): `getTokenAccountsByOwner`, `getAccountInfo`

**Wallet operations:** No RPC mocks needed (file I/O only). Mock `fs` if testing file paths.

**API calls:** Mock `fetch` to return `{ ok: true, json: () => ({...}) }` or `{ ok: false, status: 402, headers: new Headers({...}) }` for x402 paths.

## Style Guide

- **ESM only** (`import`/`export`). No TypeScript, no transpilation.
- **No interactive prompts in core functions.** Use env vars: `NANSEN_WALLET_PASSWORD`, `NANSEN_API_KEY`.
- **Error handling:** `throw new Error('descriptive message')` in core. CLI catches and formats.
- **Actionable error messages** — tell the user what to do:
  - ❌ `"Authentication failed"`
  - ✅ `"Not logged in. Run: nansen login"`
- **BigInt for token amounts.** Never use floating point. Parse to BigInt with decimals.
- **Chain branching:** Use `chain === 'solana'` checks, not inheritance/polymorphism.
- **Minimal dependencies.** Prefer Node.js built-in APIs (crypto, fs, path, http).

## PR Checklist

- [ ] `npm test` passes (all tests)
- [ ] New code paths have test coverage
- [ ] No hardcoded secrets, API keys, or private keys
- [ ] No `console.log` in core functions (use `log` dep injection)
- [ ] Error messages are actionable (tell user what to do)
- [ ] CLI help text updated if adding/changing commands
- [ ] RPC mocks cover all methods in the code path
- [ ] Wallet flows work both with and without `NANSEN_WALLET_PASSWORD`
- [ ] Changeset added if changing behavior (`npx changeset add`)

## Chains & Networks

**EVM:** Ethereum (chain ID 1), Base (8453). `CHAIN_IDS` in transfer.js only maps these two — other EVM chains will fail for transfers.

**Solana:** mainnet-beta. Supports native SOL, standard SPL tokens, and Token-2022 (Token Extensions).

**RPC endpoints:** Hardcoded in `CHAIN_RPCS` (transfer.js). Nansen API handles RPC for trading.

## Key Constants

| Constant | Value |
|----------|-------|
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| x402 payment | $0.05 USDC per API call |
| Gas buffer | API provides `quote.gas` with 1.5x multiplier — use directly |

## Known Gotchas

1. **EIP-7702 delegated accounts** on Base have contract code. Always use `eth_estimateGas`, never hardcode 21000 gas.
2. **Solana SPL account ordering:** Writable accounts (destATA) must precede readonly (mint) in the transaction message.
3. **`getSignatureStatuses`** over `confirmTransaction` — the latter is deprecated and unreliable on public RPCs.
4. **`--max` native SOL:** Reserve 5000 lamports for fee. On EVM L2s, reserve 3x estimated gas for L1 data posting fees.
5. **Token-2022:** Use `TOKEN_2022_PROGRAM_ID` and `TransferCheckedInstruction` (not plain `Transfer`).
6. **CreateATA path:** When recipient doesn't have a token account, the sender creates it. This path in transfer.js has limited test coverage — add tests if modifying.
7. **`CHAIN_IDS` is incomplete:** Only ethereum and base are mapped. Adding new EVM chain support requires updating this map.
