# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-577%20passing-brightgreen.svg)]()

> **Built by agents, for agents.** We prioritize the best possible AI agent experience.

Command-line interface for the [Nansen API](https://docs.nansen.ai) with structured JSON output, designed for AI agents and automation.

## Installation

```bash
# Install globally via npm
npm install -g nansen-cli

# Or run directly with npx
npx nansen-cli help

# Or clone and install locally
git clone https://github.com/nansen-ai/nansen-cli.git
cd nansen-cli
npm install
npm link
```

## Configuration

### For AI Agents (Recommended)

Use the [AI Agent Setup](https://app.nansen.ai/auth/agent-setup) flow:

1. Your agent will ask you to visit: **[app.nansen.ai/auth/agent-setup](https://app.nansen.ai/auth/agent-setup)**
2. Sign in with your Nansen account
3. Copy the message shown
4. Paste it back to your agent

Your agent saves the key and handles everything else automatically.

### Manual Setup

**Option 1: Interactive login**
```bash
nansen login
# Enter your API key when prompted
# ✓ Saved to ~/.nansen/config.json
```

**Option 2: Environment variable (best for agents)**
```bash
export NANSEN_API_KEY=your-api-key
```

**Option 3: Direct config file (cheapest — no validation call)**
```bash
mkdir -p ~/.nansen && echo '{"apiKey":"<key>","baseUrl":"https://api.nansen.ai"}' > ~/.nansen/config.json && chmod 600 ~/.nansen/config.json
```

Get your API key at [app.nansen.ai/api](https://app.nansen.ai/api).

### Auth Priority

1. `NANSEN_API_KEY` env var (highest)
2. `~/.nansen/config.json` file
3. Interactive prompt

> **Note:** `nansen login` validates your key by making a real API call (burns 1 credit). Writing `~/.nansen/config.json` directly is cheaper if you know the key is valid.

### Verify It Works

```bash
# Free — no API key needed:
nansen schema | head -1

# Burns 1 credit but proves API access:
nansen token screener --chain solana --limit 1
```

## Quick Start

```bash
# Get trending tokens on Solana
nansen token screener --chain solana --timeframe 24h --pretty

# Check Smart Money activity
nansen smart-money netflow --chain solana --pretty

# Profile a wallet
nansen profiler balance --address 0x28c6c06298d514db089934071355e5743bf21d60 --chain ethereum --pretty

# Search for an entity
nansen profiler search --query "Vitalik Buterin" --pretty
```

## Commands

### `smart-money` - Smart Money Analytics

Track trading and holding activity of sophisticated market participants.

| Subcommand | Description |
|------------|-------------|
| `netflow` | Net capital flows (inflows vs outflows) |
| `dex-trades` | Real-time DEX trading activity |
| `perp-trades` | Perpetual trading on Hyperliquid |
| `holdings` | Aggregated token balances |
| `dcas` | DCA strategies on Jupiter |
| `historical-holdings` | Historical holdings over time |

**Smart Money Labels:** `Fund`, `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `180D Smart Trader`, `Smart HL Perps Trader`

### `profiler` - Wallet Profiling

**ENS Name Resolution:** You can use `.eth` names anywhere an `--address` is accepted:

```bash
nansen profiler balance --address vitalik.eth
nansen profiler labels --address nansen.eth --chain ethereum
nansen profiler transactions --address vitalik.eth --table
```

ENS names are automatically resolved to `0x` addresses via public APIs (with onchain RPC fallback). Works on all EVM chains. The resolved name and address are included as `_ens` metadata in JSON output.

| Subcommand | Description |
|------------|-------------|
| `balance` | Current token holdings |
| `labels` | Behavioral and entity labels |
| `transactions` | Transaction history |
| `pnl` | PnL and trade performance |
| `search` | Search for entities by name |
| `historical-balances` | Historical balances over time |
| `related-wallets` | Find wallets related to an address |
| `counterparties` | Top counterparties by volume |
| `pnl-summary` | Summarized PnL metrics |
| `perp-positions` | Current perpetual positions |
| `perp-trades` | Perpetual trading history |

### `token` - Token God Mode

| Subcommand | Description |
|------------|-------------|
| `screener` | Discover and filter tokens |
| `holders` | Token holder analysis |
| `flows` | Token flow metrics |
| `dex-trades` | DEX trading activity |
| `pnl` | PnL leaderboard |
| `who-bought-sold` | Recent buyers and sellers |
| `flow-intelligence` | Detailed flow intelligence by label |
| `transfers` | Token transfer history |
| `jup-dca` | Jupiter DCA orders for token |
| `perp-trades` | Perp trades by token symbol |
| `perp-positions` | Open perp positions by token symbol |
| `perp-pnl-leaderboard` | Perp PnL leaderboard by token |

### `wallet` - Local Wallet Management

| Subcommand | Description |
|------------|-------------|
| `create` | Create a new wallet (EVM + Solana keypair) |
| `list` | List all wallets |
| `show` | Show wallet addresses |
| `export` | Export private keys |
| `default` | Set default wallet |
| `delete` | Delete a wallet |
| `send` | Send tokens (native or ERC-20/SPL) |

Wallets are passwordless by default (keys stored like SSH keys). Set `NANSEN_WALLET_PASSWORD` env var for encryption at rest.

### `quote` / `execute` - Trading

```bash
# Get a swap quote
nansen quote --from USDC --to SOL --amount 10 --chain solana

# Execute the swap
nansen execute --from USDC --to SOL --amount 10 --chain solana
```

### `search` - Search

```bash
nansen search "uniswap" --pretty
nansen search "uniswap" --type token --chain ethereum
```

### `schema` - Schema Discovery

No API key required. Machine-readable command reference for agent introspection.

```bash
nansen schema --pretty                    # All commands
nansen schema smart-money --pretty        # One command's options & return fields
```

### `portfolio` / `perp` / `points` / `cache`

See `nansen help` or `nansen schema --pretty` for full details.

## Options

| Option | Description |
|--------|-------------|
| `--pretty` | Format JSON output for readability |
| `--table` | Format output as human-readable table |
| `--fields <list>` | Comma-separated fields to include (reduces response size) |
| `--stream` | Output as NDJSON for incremental processing |
| `--cache` / `--no-cache` | Enable/disable response caching |
| `--cache-ttl <s>` | Cache TTL in seconds (default: 300) |
| `--chain <chain>` | Blockchain to query |
| `--chains <json>` | Multiple chains as JSON array |
| `--limit <n>` | Number of results |
| `--days <n>` | Date range in days (default: 30) |
| `--sort <field:dir>` | Sort results (e.g., `--sort value_usd:desc`) |
| `--symbol <sym>` | Token symbol for perp endpoints (e.g., BTC, ETH) |
| `--filters <json>` | Filter criteria as JSON |
| `--labels <label>` | Smart Money label filter |
| `--smart-money` | Filter for Smart Money only |
| `--timeframe <tf>` | Time window (5m, 10m, 1h, 6h, 24h, 7d, 30d) |

## Supported Chains

`ethereum` `solana` `base` `bnb` `arbitrum` `polygon` `optimism` `avalanche` `linea` `scroll` `zksync` `mantle` `ronin` `sei` `plasma` `sonic` `unichain` `monad` `hyperevm` `iotaevm`

> Run `nansen schema` to get the current chain list (source of truth).

## Agent-Optimized Patterns

### Reduce Token Burn with `--fields`

```bash
# ❌ Returns everything (huge JSON, wastes agent context)
nansen smart-money netflow --chain solana

# ✅ Only what you need
nansen smart-money netflow --chain solana --fields token_symbol,net_flow_usd,chain --limit 10
```

### Budget Credits

- Most calls cost 1 credit
- `profiler labels` + `profiler balance` are expensive — batch 3-4 at a time
- `schema`, `help`, `cache` are free (no API key needed)
- If you get `CREDITS_EXHAUSTED`, **stop immediately** — don't retry

### Use `--stream` for Large Results

```bash
# NDJSON mode — process line by line, don't buffer giant arrays
nansen token dex-trades --chain solana --limit 100 --stream
```

### x402 Micropayments

When the API returns a 402 Payment Required, the CLI automatically handles payment if a funded wallet exists:

1. CLI detects 402 response with payment requirements
2. Signs a USDC payment ($0.05/call) using your wallet
3. Retries the request with the payment signature
4. Falls back from EVM to Solana if first network has insufficient funds

```bash
# Fund your wallet, then API calls auto-pay
nansen wallet create
# Send USDC to the displayed address
nansen smart-money netflow --chain solana  # auto-pays if no API key
```

## Pagination

The CLI exposes `--limit N` which maps to `{page: 1, per_page: N}`. **There is no `--page` flag** — the CLI always fetches page 1. For later pages, use the REST API directly:

```bash
curl -s -X POST https://api.nansen.ai/api/v1/smart-money/netflow \
  -H "apiKey: $NANSEN_API_KEY" -H "Content-Type: application/json" \
  -d '{"chains":["solana"],"pagination":{"page":2,"per_page":50}}'
```

**Detecting the last page:** If results returned < your `--limit`, you're on the last page.

**Note:** `profiler perp-positions` has no pagination — the API ignores the pagination parameter.

## Output Format

### Response envelope

```json
// Success
{ "success": true, "data": <raw_api_response> }

// Error
{ "success": false, "error": "message", "code": "ERROR_CODE", "status": 401, "details": {...} }
```

### Response shapes vary by endpoint

The `data` field structure differs across endpoints:

| Shape | Example endpoints |
|-------|------------------|
| `data.data` (array) | token screener |
| `data.results` (array) | entity search |
| `data.data.results` (array) | most profiler endpoints |
| `data.netflows` | smart-money netflow |
| `data.trades` | smart-money dex-trades |
| `data.holdings` | smart-money holdings |
| `data.holders` | token holders |

`--table` and `--stream` handle this automatically. For raw JSON parsing:

```bash
nansen smart-money netflow --chain solana | jq 'keys, .data | keys'
```

### Error codes

| Code | Action |
|------|--------|
| `CREDITS_EXHAUSTED` | **Stop all calls.** Tell the human. |
| `RATE_LIMITED` | Wait — auto-retry handles this. |
| `UNSUPPORTED_FILTER` | Remove the filter, retry without it. |
| `UNAUTHORIZED` | Key is wrong or missing. Re-auth. |
| `INVALID_ADDRESS` | Check address format for the chain. |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `command not found: nansen` | `npm install -g nansen-cli` or `npx nansen-cli` |
| `UNAUTHORIZED` after login | Check `cat ~/.nansen/config.json`. Write directly if needed. |
| Login hangs | Skip `nansen login`, write config directly. |
| Huge JSON response | Use `--fields` to select only needed columns. |
| Perp endpoints empty | Use `--symbol BTC` not `--token`. Perps are Hyperliquid-only. |
| `UNSUPPORTED_FILTER` on token holders | Not all tokens have smart money data. Remove `--smart-money`. |
| `CREDITS_EXHAUSTED` | Stop all calls. Check [app.nansen.ai](https://app.nansen.ai). |

### Known endpoint quirks

- **`token holders --smart-money`** — Fails with `UNSUPPORTED_FILTER` for tokens without smart money tracking. Do not retry.
- **`token flow-intelligence`** — May return all-zero flows for illiquid tokens. Normal, not an error.
- **`profiler labels`/`balance`** consume credits. Budget ~20 calls per session.
- **`token screener --search`** is client-side filtering. Set `--limit` higher than expected results.
- **`--fields`** applies to the entire response tree, stripping the `success`/`data` wrapper too.
- **Profiler beta endpoints** use `recordsPerPage` instead of `per_page`. The CLI handles this automatically.

## Development

```bash
npm test              # Run tests (mocked, no API key needed)
npm run test:coverage # With coverage
npm run test:live     # Against live API (needs NANSEN_API_KEY)
```

See [AGENTS.md](AGENTS.md) for contributor guidance (architecture, testing patterns, style guide).

## API Coverage

| Category | Endpoints | Coverage |
|----------|-----------|----------|
| Smart Money | 6 | 100% |
| Profiler | 11 | 100% |
| Token God Mode | 12 | 100% |
| Portfolio | 1 | 100% |
| Search | 1 | 100% |
| **Total** | **31** | **100%** |

## License

[MIT](LICENSE) © [Nansen](https://nansen.ai)
