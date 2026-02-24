# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-325%20passing-brightgreen.svg)]()
[![Coverage](https://img.shields.io/badge/coverage-83%25-brightgreen.svg)]()

> **Built by agents, for agents.** We prioritize the best possible AI agent experience.

Command-line interface for the [Nansen API](https://docs.nansen.ai) with structured JSON output, designed for AI agents and automation. Analyze on-chain data, profile wallets, track Smart Money, and execute trades, all from your terminal.

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

**Option 2: Environment variable**
```bash
export NANSEN_API_KEY=your-api-key
```

Get your API key at [app.nansen.ai/api](https://app.nansen.ai/api).

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

# Get a DEX swap quote and execute it
nansen quote --chain solana --from So11111111111111111111111111111111111111112 --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 1000000000
nansen execute --quote <quoteId>
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

**Smart Money Labels:**
- `Fund` - Institutional investment funds
- `Smart Trader` - Historically profitable traders
- `30D Smart Trader` - Top performers (30-day window)
- `90D Smart Trader` - Top performers (90-day window)
- `180D Smart Trader` - Top performers (180-day window)
- `Smart HL Perps Trader` - Profitable Hyperliquid traders

### `profiler` - Wallet Profiling

Detailed information about any blockchain address.

| Subcommand | Description |
|------------|-------------|
| `balance` | Current token holdings |
| `labels` | Behavioral and entity labels |
| `transactions` | Transaction history |
| `pnl` | PnL and trade performance |
| `pnl-summary` | Summarized PnL metrics |
| `search` | Search for entities by name |
| `historical-balances` | Historical balances over time |
| `related-wallets` | Find wallets related to an address |
| `counterparties` | Top counterparties by volume |
| `perp-positions` | Current perpetual positions |
| `perp-trades` | Perpetual trading history |
| `batch` | Query multiple addresses at once |
| `trace` | Trace fund flows between wallets |
| `compare` | Compare multiple wallets side by side |

### `token` - Token God Mode

Deep analytics for any token.

| Subcommand | Description |
|------------|-------------|
| `info` | Token metadata and stats |
| `indicators` | Technical indicators and signals |
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

### `perp` - Perpetual Futures Analytics

| Subcommand | Description |
|------------|-------------|
| `screener` | Screen perpetual futures contracts |
| `leaderboard` | Perpetual futures PnL leaderboard |

### `quote` + `execute` - Trading

Get DEX swap quotes and execute trades directly from the CLI.

```bash
# Get a quote (SOL → USDC on Solana)
nansen quote --chain solana \
  --from So11111111111111111111111111111111111111112 \
  --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 1000000000

# Execute the quoted trade
nansen execute --quote <quoteId>

# With custom slippage
nansen quote --chain base --from 0xeee... --to 0x833... --amount 1000000000000000000 --slippage 0.01

# Auto slippage
nansen quote --chain solana --from <token> --to <token> --amount <units> --auto-slippage
```

| Option | Description |
|--------|-------------|
| `--chain` | Chain: `solana`, `ethereum`, `base`, `bsc` |
| `--from` | Input token address |
| `--to` | Output token address |
| `--amount` | Amount in base units (lamports, wei) |
| `--slippage` | Slippage tolerance as decimal (default: 0.03) |
| `--auto-slippage` | Enable auto slippage calculation |
| `--swap-mode` | `exactIn` (default) or `exactOut` |
| `--no-simulate` | Skip pre-broadcast simulation (execute only) |

### `wallet` - Wallet Management

Create and manage local wallets for trading. Supports both EVM and Solana.

```bash
# Create a new wallet (generates EVM + Solana keypair)
nansen wallet create --name trading

# List wallets
nansen wallet list

# Set default wallet
nansen wallet default trading

# Send tokens
nansen wallet send --to 0x742d35Cc... --amount 1.5 --chain evm
nansen wallet send --to 9WzDXw... --amount 0.1 --chain solana --token So11...

# Send entire balance
nansen wallet send --to 0x742d35Cc... --chain evm --max

# Preview without sending
nansen wallet send --to 0x742d35Cc... --amount 1.5 --chain evm --dry-run

# Export private keys (password required)
nansen wallet export trading
```

| Environment Variable | Description |
|---------------------|-------------|
| `NANSEN_WALLET_PASSWORD` | Password for non-interactive use (CI/scripts) |
| `NANSEN_EVM_RPC` | Custom EVM RPC endpoint |
| `NANSEN_SOLANA_RPC` | Custom Solana RPC endpoint |

### `portfolio` - Portfolio Analytics

| Subcommand | Description |
|------------|-------------|
| `defi` | DeFi holdings across protocols |

### `search` - Search

Search for tokens and entities across Nansen.

```bash
nansen search "uniswap" --pretty
nansen search "uniswap" --type token --chain ethereum
```

| Option | Description |
|--------|-------------|
| `--type` | Filter by result type: `token`, `entity`, or `any` (default) |
| `--chain` | Filter by chain |
| `--limit` | Max results, 1-50 (default: 25) |

### `points` - Nansen Points

| Subcommand | Description |
|------------|-------------|
| `leaderboard` | Nansen Points leaderboard |

### `schema` - Schema Discovery

Output JSON schema for agent introspection. No API key required.

```bash
# Get full schema
nansen schema --pretty

# Get schema for specific command
nansen schema smart-money --pretty
```

Returns command definitions, option types/defaults, supported chains, and smart money labels.

### `cache` - Cache Management

```bash
# Clear all cached responses
nansen cache clear
```

## Output Formats

The CLI supports multiple output formats to suit different workflows:

```bash
# Structured JSON (default) — ideal for AI agents and piping
nansen token screener --chain solana

# Formatted JSON — human-readable with indentation
nansen token screener --chain solana --pretty

# Table — clean terminal-friendly tables with auto-formatted numbers
nansen token screener --chain solana --table

# CSV — for spreadsheets and data analysis
nansen token screener --chain solana --format csv

# NDJSON streaming — for incremental processing of large datasets
nansen token screener --chain solana --stream

# Select specific fields — reduce payload size
nansen smart-money netflow --chain solana --fields token_symbol,net_flow_24h_usd,trader_count
```

## Global Options

| Option | Description |
|--------|-------------|
| `--pretty` | Format JSON output for readability |
| `--table` | Format output as human-readable table |
| `--format csv` | Output as CSV with header row |
| `--stream` | Output as JSON lines (NDJSON) for incremental processing |
| `--fields <list>` | Comma-separated fields to include (reduces response size) |
| `--chain <chain>` | Blockchain to query |
| `--chains <json>` | Multiple chains as JSON array |
| `--limit <n>` | Number of results |
| `--days <n>` | Date range in days (default: 30) |
| `--sort <field:dir>` | Sort results (e.g., `--sort value_usd:desc`) |
| `--order-by <json>` | Sort order as JSON array (advanced) |
| `--filters <json>` | Filter criteria as JSON |
| `--symbol <sym>` | Token symbol for perp endpoints (e.g., BTC, ETH) |
| `--labels <label>` | Smart Money label filter |
| `--smart-money` | Filter for Smart Money only |
| `--timeframe <tf>` | Time window (5m, 10m, 1h, 6h, 24h, 7d, 30d) |
| `--cache` | Enable response caching |
| `--no-cache` | Bypass cache for this request |
| `--cache-ttl <s>` | Cache TTL in seconds (default: 300) |
| `--no-retry` | Disable automatic retry on rate limits/errors |
| `--retries <n>` | Max retry attempts (default: 3) |

## Supported Chains

`ethereum`, `solana`, `base`, `bnb`, `arbitrum`, `polygon`, `optimism`, `avalanche`, `linea`, `scroll`, `zksync`, `mantle`, `ronin`, `sei`, `plasma`, `sonic`, `unichain`, `monad`, `hyperevm`, `iotaevm`

## AI Agent Integration

This CLI is built specifically for AI agents. Every design decision prioritizes agent usability.

**Getting Started:**
Direct your users to [app.nansen.ai/auth/agent-setup](https://app.nansen.ai/auth/agent-setup) for seamless authentication. See [AI Agent Access](https://docs.nansen.ai/reference/ai-agent-access) for full documentation.

**Why agents love it:**
- **Structured Output**: All responses are JSON with consistent schema. No parsing HTML or unstructured text.
- **Predictable Errors**: Errors include status codes and actionable details agents can handle programmatically.
- **Zero Config**: Works with just an API key. No complex setup.
- **Composable**: Commands can be chained with shell pipes.
- **Discoverable**: `nansen schema` outputs full JSON schema for agent introspection. No API key required.
- **Cacheable**: Built-in response caching with configurable TTL reduces redundant API calls.
- **Field Selection**: `--fields` flag reduces token usage by returning only what's needed.

```json
// Success response
{
  "success": true,
  "data": {
    "results": [...],
    "pagination": {...}
  }
}

// Error response
{
  "success": false,
  "error": "API error message",
  "code": "UNAUTHORIZED",
  "status": 401,
  "details": {...}
}
```

## Examples

```bash
# Discover tokens — table view, sorted by volume
nansen token screener --chain solana --sort buy_volume:desc --table

# Smart Money DEX trades from Funds only
nansen smart-money dex-trades --chain ethereum --labels Fund --table

# Token holders filtered to Smart Money
nansen token holders --token So11111111111111111111111111111111111111112 --chain solana --smart-money

# Historical Smart Money holdings over 7 days
nansen smart-money historical-holdings --chain solana --days 7

# BTC perpetual positions on Hyperliquid
nansen token perp-positions --symbol BTC --pretty

# Top PnL traders for JUP, sorted by realized PnL
nansen token pnl --token JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN --chain solana --days 30 --sort pnl_usd:desc --table

# Perp futures screener
nansen perp screener --pretty

# Compare two wallets side by side
nansen profiler compare --addresses 0xabc...,0xdef... --chain ethereum

# Trace fund flows
nansen profiler trace --address 0xabc... --chain ethereum

# Batch query multiple addresses
nansen profiler batch --addresses 0xabc...,0xdef...,0x123... --chain ethereum

# Reduce payload for agents — select only needed fields
nansen smart-money netflow --chain solana --fields token_symbol,net_flow_24h_usd,trader_count

# Export to CSV for spreadsheet analysis
nansen token screener --chain solana --timeframe 24h --format csv > tokens.csv

# Stream results as NDJSON
nansen smart-money dex-trades --chain solana --stream

# Full trading flow: quote and execute
nansen wallet create --name trading
nansen quote --chain solana --from So11...112 --to EPjFW...Dt1v --amount 1000000000
nansen execute --quote <quoteId>

# Schema introspection for agents
nansen schema --pretty
nansen schema token --pretty
```

## Development

```bash
# Run tests (mocked, no API key needed)
npm test

# Run with coverage
npm run test:coverage

# Run against live API
NANSEN_API_KEY=your-key npm run test:live
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

**AI agents:** See [AGENTS.md](AGENTS.md) for the agent quick-start (install, auth, patterns, troubleshooting).

**AI contributors:** See [CLAUDE.md](CLAUDE.md) for agent-specific guidance on contributing to this repo.

## API Coverage

| Category | Endpoints | Coverage |
|----------|-----------|----------|
| Smart Money | 6 | 100% |
| Profiler | 14 | 100% |
| Token God Mode | 14 | 100% |
| Perpetuals | 2 | 100% |
| Portfolio | 1 | 100% |
| Trading | 2 | 100% |
| Wallet | 6 | 100% |
| Search | 1 | 100% |
| Points | 1 | 100% |
| **Total** | **47** | **100%** |

## License

[MIT](LICENSE) © [Nansen](https://nansen.ai)
