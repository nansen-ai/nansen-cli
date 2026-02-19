# Changelog

## 1.4.0

### Minor Changes

- [`7dd9845`](https://github.com/nansen-ai/nansen-cli/commit/7dd984581e6d3babd16060aa344cdf8495c866e4) Thanks [@askeluv](https://github.com/askeluv)! - Add missing endpoints to align with Python SDK:

  - token info: Get detailed token information
  - perp screener: Screen perpetual futures contracts
  - perp leaderboard: Perpetual futures PnL leaderboard
  - points leaderboard: Nansen Points leaderboard

- [`778fb71`](https://github.com/nansen-ai/nansen-cli/commit/778fb71ed56cf32c06376e5263af36c57c34a18b) Thanks [@askeluv](https://github.com/askeluv)! - Add subcommand-specific help and command aliases

  - `nansen <command> <subcommand> --help` now shows detailed help including description, required/optional parameters with defaults, return fields, and working examples
  - `nansen <command> --help` lists all available subcommands
  - Added command aliases for faster typing: `tgm` (token), `sm` (smart-money), `prof` (profiler), `port` (portfolio)

### Patch Changes

- [#9](https://github.com/nansen-ai/nansen-cli/pull/9) [`3efc2ce`](https://github.com/nansen-ai/nansen-cli/commit/3efc2cef3322e192b02a6a4e8955e53f3c7c6ab4) Thanks [@0xlaveen](https://github.com/0xlaveen)! - fix: profiler pnl endpoint, token screener --search, help shows all subcommands

  - `profiler pnl` now uses correct endpoint `/api/v1/profiler/address/pnl` (was using non-existent `/pnl-and-trade-performance`). Now supports `--date` and `--limit`.
  - `token screener --search PEPE` now filters results by token symbol/name (client-side, API doesn't support server-side search)
  - Help text updated to list all 33 subcommands (was showing only 16, hiding 17 commands)
  - Schema updated with `search` option for screener and `date`/`days`/`limit` for profiler pnl

## 1.3.3

### Patch Changes

- [`1c3857f`](https://github.com/nansen-ai/nansen-cli/commit/1c3857fd019703ff1b4620f7feed4152d3234a6a) Thanks [@askeluv](https://github.com/askeluv)! - Fix repository URL in package.json (nansen-ai → askeluv)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-02-16

### Fixed

- Profiler 404 errors on valid addresses
- Schema field name mismatches
- Invalid fields being sent to API
- Smart Money filter now uses correct `include_smart_money_labels` parameter

### Changed

- Removed unsupported chains (zksync, unichain)

### Added

- SKILL.md for skills.sh discoverability
- Automated versioning with changesets

## [1.3.0] - 2026-02-06

### Added

- ASCII art welcome banner with "Surface The Signal" tagline
- Index.js test coverage (now 100%)

### Changed

- Improved test reliability with afterEach timer cleanup
- Test coverage increased to 83% (325 tests)

## [1.0.0] - 2026-01-31

### Added

- Initial public release
- **Smart Money** commands: `netflow`, `dex-trades`, `perp-trades`, `holdings`, `dcas`, `historical-holdings`
- **Profiler** commands: `balance`, `labels`, `transactions`, `pnl`, `search`, `historical-balances`, `related-wallets`, `counterparties`, `pnl-summary`, `perp-positions`, `perp-trades`
- **Token God Mode** commands: `screener`, `holders`, `flows`, `dex-trades`, `pnl`, `who-bought-sold`, `flow-intelligence`, `transfers`, `jup-dca`, `perp-trades`, `perp-positions`, `perp-pnl-leaderboard`
- **Portfolio** commands: `defi`
- Address validation for EVM, Solana, and Bitcoin formats
- JSON output by default, `--pretty` flag for human-readable formatting
- `--days` option for date range queries
- `--symbol` option for perp endpoints
- Support for 20+ blockchain networks
- Comprehensive test suite (138 tests)
