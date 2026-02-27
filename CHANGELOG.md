# Changelog

## 1.9.0

### Minor Changes

- [#98](https://github.com/nansen-ai/nansen-cli/pull/98) [`2f3f556`](https://github.com/nansen-ai/nansen-cli/commit/2f3f556d008a1f8ec40d57a8a2822bedbc6b60cb) Thanks [@Codier](https://github.com/Codier)! - Add symbol shortcuts for common tokens (SOL, ETH, USDC, USDT, etc.) that resolve to canonical addresses per chain. Users can now use `--from SOL --to USDC` instead of raw contract addresses.

- [#106](https://github.com/nansen-ai/nansen-cli/pull/106) [`135aa79`](https://github.com/nansen-ai/nansen-cli/commit/135aa79e662febd356935d85c9ba783c1a46738f) Thanks [@TimNooren](https://github.com/TimNooren)! - Add WalletConnect support for trading, transfers, and x402 auto-payment (EVM only)

### Patch Changes

- [#99](https://github.com/nansen-ai/nansen-cli/pull/99) [`9144cba`](https://github.com/nansen-ai/nansen-cli/commit/9144cba38b06c90d462df97ea6cbcdeaed26fa36) Thanks [@Codier](https://github.com/Codier)! - Show clear error when `--amount` contains a decimal (e.g. `0.005`) instead of base units (lamports, wei). Detected client-side before hitting the API.

- [#100](https://github.com/nansen-ai/nansen-cli/pull/100) [`19559bf`](https://github.com/nansen-ai/nansen-cli/commit/19559bfea6c22f6bd6b8c278ed5e6ae6d64866d5) Thanks [@Codier](https://github.com/Codier)! - Fix `nansen trade help` returning blank output. Now prints subcommands, usage, and examples. Also fixes `errorOutput` ReferenceError in `buildCommands` scope (affected `trade` and `changelog` commands).

- [#93](https://github.com/nansen-ai/nansen-cli/pull/93) [`342c91f`](https://github.com/nansen-ai/nansen-cli/commit/342c91fdeb6d98d6b5c10a58cb9702eb5afe096f) Thanks [@Codier](https://github.com/Codier)! - Warn when `--from` is a wrapped native token (WETH/WBNB) or native sentinel, so AI agents can correct the token before execution fails

## 1.8.0

### Minor Changes

- [#56](https://github.com/nansen-ai/nansen-cli/pull/56) [`d10998a`](https://github.com/nansen-ai/nansen-cli/commit/d10998aa2be19f80e8476d19bfd46029757a7335) Thanks [@askeluv](https://github.com/askeluv)! - Add CHANGELOG.md, `nansen changelog` command, and post-update "what's new" notice

  - Added CHANGELOG.md following Keep a Changelog format with history back to v1.5.0
  - Added `nansen changelog` command with `--since <version>` filtering
  - Added one-time upgrade notice on first run after version update (prints to stderr)

- [#77](https://github.com/nansen-ai/nansen-cli/pull/77) [`46e4660`](https://github.com/nansen-ai/nansen-cli/commit/46e4660034d9681405d09a5184f78525c300b8a5) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Add token-ohlcv endpoint for OHLCV candle data

- [#75](https://github.com/nansen-ai/nansen-cli/pull/75) [`287937e`](https://github.com/nansen-ai/nansen-cli/commit/287937e1d307e0b3f25648863d0c5b4a54d215ff) Thanks [@TimNooren](https://github.com/TimNooren)! - Restructure CLI into research/trade/wallet namespaces

  - Commands reorganized: `smart-money`, `profiler`, `token`, `portfolio` now live under `nansen research`
  - New `nansen trade` namespace for `quote` and `execute`
  - New `nansen wallet` namespace for wallet management
  - Old top-level commands still work with deprecation warnings

- [#61](https://github.com/nansen-ai/nansen-cli/pull/61) [`9af0192`](https://github.com/nansen-ai/nansen-cli/commit/9af01921871be1d0537047cb4ad9733e01876646) Thanks [@askeluv](https://github.com/askeluv)! - Add ENS name resolution for profiler commands. Use `.eth` names directly in `--address` flags — resolved automatically via ensideas API with onchain RPC fallback. Works across all profiler subcommands, batch, and trace operations.

All notable changes to the Nansen CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.7.0] - 2026-02-24

### Added

- **Trading commands** — `quote` and `execute` for DEX swaps (EVM + Solana)
- **Wallet management** — `wallet create`, `list`, `show`, `export`, `default`, `delete`
- **Wallet send** — transfer tokens on EVM and Solana (`wallet send`)
- **x402 auto-payment** — automatic payment via Base USDC or Solana SPL USDC
- Explorer links in transaction output
- `--dry-run` flag for `wallet send`
- x402 low balance warning
- AI Agent Access setup docs and improved onboarding flow

### Fixed

- Solana execute crash with OKX quotes
- x402 auto-pay retry path (3 reference errors)
- Gas estimation — use API `quote.gas` as floor
- Pre-flight simulation moved after approval (industry standard)
- EVM signing edge cases with pure JS ECDSA
- Wallet send crashes on amount parsing and silent success
- Solana confirmation and SPL token transfer account ordering
- Suppress duplicate JSON output from quote/execute
- Suppress approval warning for native ETH swaps

### Changed

- Pricing clarity — from $0.01/call, min $0.05 balance
- Consolidated crypto primitives into shared module

## [1.6.0] - 2026-02-14

### Added

- `token indicators` endpoint
- `profiler search` — general entity search command
- `--x402-payment-signature` flag for pre-signed payment headers
- `X-Client-Type` and `X-Client-Version` tracking headers on all API requests

### Fixed

- Error JSON now outputs to stdout (not stderr) for consistent agent parsing
- Config loading — environment variables correctly override file config

## [1.5.1] - 2026-02-07

### Added

- Allow API requests without API key when using x402 payment flow

## [1.5.0] - 2026-01-31

_Baseline version. Changes above are relative to this release._
