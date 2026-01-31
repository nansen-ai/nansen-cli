# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-138%20passing-brightgreen.svg)]()

Command-line interface for the [Nansen API](https://docs.nansen.ai). Designed for AI agents with structured JSON output.

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

**Option 1: Interactive login (recommended)**
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
| `search` | Search for entities by name |
| `historical-balances` | Historical balances over time |
| `related-wallets` | Find wallets related to an address |
| `counterparties` | Top counterparties by volume |
| `pnl-summary` | Summarized PnL metrics |
| `perp-positions` | Current perpetual positions |
| `perp-trades` | Perpetual trading history |

### `token` - Token God Mode

Deep analytics for any token.

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

### `portfolio` - Portfolio Analytics

| Subcommand | Description |
|------------|-------------|
| `defi` | DeFi holdings across protocols |

## Options

| Option | Description |
|--------|-------------|
| `--pretty` | Format JSON output for readability |
| `--table` | Format output as human-readable table |
| `--chain <chain>` | Blockchain to query |
| `--chains <json>` | Multiple chains as JSON array |
| `--limit <n>` | Number of results |
| `--days <n>` | Date range in days (default: 30) |
| `--sort <field:dir>` | Sort results (e.g., `--sort value_usd:desc`) |
| `--symbol <sym>` | Token symbol for perp endpoints (e.g., BTC, ETH) |
| `--filters <json>` | Filter criteria as JSON |
| `--order-by <json>` | Sort order as JSON array (advanced) |
| `--labels <label>` | Smart Money label filter |
| `--smart-money` | Filter for Smart Money only |
| `--timeframe <tf>` | Time window (5m, 10m, 1h, 6h, 24h, 7d, 30d) |

## Supported Chains

`ethereum`, `solana`, `base`, `bnb`, `arbitrum`, `polygon`, `optimism`, `avalanche`, `linea`, `scroll`, `zksync`, `mantle`, `ronin`, `sei`, `plasma`, `sonic`, `unichain`, `monad`, `hyperevm`, `iotaevm`

## AI Agent Integration

The CLI is designed for AI agents and automation:

- **Structured Output**: All responses are JSON with consistent schema
- **Error Handling**: Errors include status codes and actionable details
- **Composable**: Commands can be chained with shell pipes
- **Discoverable**: `help` commands at every level

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
  "status": 401,
  "details": {...}
}
```

## Examples

```bash
# Get trending tokens as a table, sorted by volume
nansen token screener --chain solana --sort buy_volume:desc --table

# Get Smart Money DEX trades from Funds only
nansen smart-money dex-trades --chain ethereum --labels Fund --table

# Get token holders with Smart Money filter
nansen token holders --token So11111111111111111111111111111111111111112 --chain solana --smart-money

# Get historical holdings for the past 7 days
nansen smart-money historical-holdings --chain solana --days 7

# Get BTC perpetual positions on Hyperliquid
nansen token perp-positions --symbol BTC --pretty

# Get top PnL traders for a token, sorted by realized PnL
nansen token pnl --token JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN --chain solana --days 30 --sort pnl_usd:desc --table
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

## API Coverage

| Category | Endpoints | Coverage |
|----------|-----------|----------|
| Smart Money | 6 | 100% |
| Profiler | 11 | 100% |
| Token God Mode | 12 | 100% |
| Portfolio | 1 | 100% |
| **Total** | **30** | **100%** |

## License

[MIT](LICENSE) © [Nansen](https://nansen.ai)
