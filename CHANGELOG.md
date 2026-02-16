# Changelog

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
