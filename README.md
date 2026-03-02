# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Built by agents, for agents.** Command-line interface for the [Nansen API](https://docs.nansen.ai) with structured JSON output.

## Installation

```bash
npm install -g nansen-cli
npx skills add nansen-ai/nansen-cli  # load agent skill files
```

## Auth

```bash
nansen login              # interactive — saves to ~/.nansen/config.json
export NANSEN_API_KEY=... # or env var (highest priority)
```

Get your API key at [app.nansen.ai/api](https://app.nansen.ai/api). AI agents can use the [Agent Setup](https://app.nansen.ai/auth/agent-setup) flow instead.

## Commands

```
nansen research <category> <subcommand> [options]
nansen trade <subcommand> [options]
nansen wallet <subcommand> [options]
nansen schema [command] [--pretty]    # full command reference (no API key needed)
```

**Research categories:** `smart-money` (`sm`), `token` (`tgm`), `profiler` (`prof`), `portfolio` (`port`), `prediction-market` (`pm`), `search`, `perp`, `points`

**Trade:** `quote`, `execute` — DEX swaps on Solana and Base.

**Wallet:** `create`, `list`, `show`, `export`, `default`, `delete`, `send` — local keypairs (EVM + Solana).

Run `nansen schema --pretty` for the full subcommand and field reference.

**Smart Money Labels:** `Fund`, `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `180D Smart Trader`, `Smart HL Perps Trader`

#### `research profiler` - Wallet Profiling

**ENS Name Resolution:** You can use `.eth` names anywhere an `--address` is accepted:

```bash
nansen research profiler balance --address vitalik.eth
nansen research profiler labels --address nansen.eth --chain ethereum
nansen research profiler transactions --address vitalik.eth --table
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

#### `research token` - Token God Mode

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
| `ohlcv` | OHLCV candle data for a token |
| `perp-trades` | Perp trades by token symbol |
| `perp-positions` | Open perp positions by token symbol |
| `perp-pnl-leaderboard` | Perp PnL leaderboard by token |

#### `research prediction-market` (alias: `pm`) - Polymarket Analytics

| Subcommand | Description |
|------------|-------------|
| `ohlcv` | OHLCV candle data for a market |
| `orderbook` | Current orderbook levels |
| `top-holders` | Top holders for a market |
| `trades-by-market` | Recent trades for a market |
| `trades-by-address` | Trades for a specific address |
| `market-screener` | Screen and discover markets |
| `event-screener` | Screen and discover events |
| `pnl-by-market` | PnL leaderboard for a market |
| `pnl-by-address` | PnL breakdown for an address |
| `position-detail` | Detailed position data |
| `categories` | List market categories |

Screener options: `--sort-by` (volume_24hr, volume, volume_1wk, volume_1mo, liquidity, open_interest, unique_traders_24h, age_hours), `--query` (search text), `--status` (active, closed). Screeners return active/open markets by default. Other endpoints (ohlcv, trades, pnl, etc.) work with any market ID regardless of status.

```bash
# Screen prediction markets by volume
nansen research pm market-screener --sort-by volume_24hr --limit 20 --pretty

# Search for specific markets
nansen research pm market-screener --query "bitcoin" --limit 10

# Find resolved/closed markets
nansen research pm market-screener --status closed --limit 10

# Get OHLCV data for a market
nansen research pm ohlcv --market-id 654412 --sort period_start:desc --pretty

# View top holders
nansen research pm top-holders --market-id 654412 --limit 10 --table

# Check trader PnL
nansen research pm pnl-by-address --address 0x1234... --pretty

# Browse categories
nansen research pm categories --pretty
```

#### `research search` / `research perp` / `research portfolio` / `research points`

See `nansen research help` or `nansen schema --pretty` for full details.

### `trade` - DEX Trading

```bash
# Get a swap quote
nansen trade quote --from USDC --to SOL --amount 10 --chain solana

# Execute the swap
nansen trade execute --from USDC --to SOL --amount 10 --chain solana
```

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

### `schema` - Schema Discovery

No API key required. Machine-readable command reference for agent introspection.

```bash
nansen schema --pretty                    # All commands
nansen schema research --pretty           # Research commands
```

### Deprecated Flat Commands

The old flat commands (`nansen smart-money`, `nansen token`, `nansen profiler`, `nansen search`, `nansen perp`, `nansen portfolio`, `nansen points`, `nansen quote`, `nansen execute`) still work but print a deprecation warning to stderr. Use the new `research` and `trade` namespaces instead.

## Key Options

| Option | Description |
|--------|-------------|
| `--chain <chain>` | Blockchain to query |
| `--limit <n>` | Result count |
| `--timeframe <tf>` | Time window: `5m` `1h` `6h` `24h` `7d` `30d` |
| `--fields <list>` | Comma-separated fields (reduces response size) |
| `--sort <field:dir>` | Sort results, e.g. `--sort value_usd:desc` |
| `--pretty` | Human-readable JSON |
| `--table` | Table format |
| `--stream` | NDJSON output for large results |
| `--labels <label>` | Smart Money label filter |
| `--smart-money` | Filter for Smart Money addresses only |

## Supported Chains

`ethereum` `solana` `base` `bnb` `arbitrum` `polygon` `optimism` `avalanche` `linea` `scroll` `zksync` `mantle` `ronin` `sei` `plasma` `sonic` `unichain` `monad` `hyperevm` `iotaevm`

> Run `nansen schema` to get the current chain list (source of truth).

## Agent Tips

**Reduce token burn with `--fields`:**
```bash
nansen research smart-money netflow --chain solana --fields token_symbol,net_flow_usd --limit 10
```

**Use `--stream` for large results** — outputs NDJSON instead of buffering a giant array.

**ENS names** work anywhere `--address` is accepted: `--address vitalik.eth`

## Output Format

```json
{ "success": true,  "data": <api_response> }
{ "success": false, "error": "message", "code": "ERROR_CODE", "status": 401 }
```

**Critical error codes:**

| Code | Action |
|------|--------|
| `CREDITS_EXHAUSTED` | Stop all API calls immediately. Check [app.nansen.ai](https://app.nansen.ai). |
| `UNAUTHORIZED` | Wrong or missing key. Re-auth. |
| `RATE_LIMITED` | Auto-retried by CLI. |
| `UNSUPPORTED_FILTER` | Remove the filter and retry. |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `command not found` | `npm install -g nansen-cli` |
| `UNAUTHORIZED` after login | `cat ~/.nansen/config.json` or set `NANSEN_API_KEY` |
| Empty perp results | Use `--symbol BTC`, not `--token`. Perps are Hyperliquid-only. |
| `UNSUPPORTED_FILTER` on token holders | Remove `--smart-money` — not all tokens have that data. |
| Huge JSON response | Use `--fields` to select columns. |

## Development

```bash
npm test              # mocked tests, no API key needed
npm run test:live     # live API (needs NANSEN_API_KEY)
```

See [AGENTS.md](AGENTS.md) for architecture and contributor guidance.

## API Coverage

| Category | Endpoints | Coverage |
|----------|-----------|----------|
| Smart Money | 6 | 100% |
| Profiler | 11 | 100% |
| Token God Mode | 12 | 100% |
| Prediction Market | 11 | 100% |
| Portfolio | 1 | 100% |
| Search | 1 | 100% |
| Perp | 3 | 100% |
| Points | 2 | 100% |
| **Total** | **47** | **100%** |

## License

[MIT](LICENSE) © [Nansen](https://nansen.ai)
