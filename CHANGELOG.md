# Changelog

## 1.10.0

### Minor Changes

- [#125](https://github.com/nansen-ai/nansen-cli/pull/125) [`5a5a80a`](https://github.com/nansen-ai/nansen-cli/commit/5a5a80af9c2c5b93efcc707925b004f077e13c36) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Add modular skills/ directory with 7 agent-optimised SKILL.md files (nansen-token, nansen-smart-money, nansen-profiler, nansen-trade, nansen-wallet, nansen-perp, nansen-search) following the linear-cli pattern. Each skill has scoped frontmatter, agent routing descriptions, bash examples, and exit codes. Add skills nudge to `nansen --help` output.

### Patch Changes

- [#122](https://github.com/nansen-ai/nansen-cli/pull/122) [`9a1ada8`](https://github.com/nansen-ai/nansen-cli/commit/9a1ada8543cd6fdbcc10d2d5004fe2e2e1a88928) Thanks [@TimNooren](https://github.com/TimNooren)! - `nansen research <unknown>` and `nansen trade <unknown>` now exit with code 1 and return `{"success":false,...}` instead of silently exiting 0.

- [#138](https://github.com/nansen-ai/nansen-cli/pull/138) [`c61881f`](https://github.com/nansen-ai/nansen-cli/commit/c61881f5455b9fff7fb97841652a72af58ab8e0b) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix `nansen login --help` to show usage instead of erroring. Previously, `--help` was silently ignored on TTY (showing the interactive prompt) and caused an error on non-TTY. Also fixes the post-login suggested command to use the non-deprecated `nansen research token screener` path.

- [#129](https://github.com/nansen-ai/nansen-cli/pull/129) [`eeabf89`](https://github.com/nansen-ai/nansen-cli/commit/eeabf8988dafc7fb1964fd2eef629f03c6a4420a) Thanks [@araa47](https://github.com/araa47)! - Fix `token ohlcv` sending unsupported pagination/limit params that caused 422 errors

- [#139](https://github.com/nansen-ai/nansen-cli/pull/139) [`e86dc68`](https://github.com/nansen-ai/nansen-cli/commit/e86dc6869f524d3dc59da4c7c04cb1ace1b7246b) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix API key prompt masking: each keystroke was showing the real character followed by `*` (e.g. `f*o*o*`) because the readline interface was active alongside raw mode, causing double output. Moving readline creation into the non-hidden branch eliminates the double-echo and also fixes backspace incorrectly clearing the prompt label.

- [#129](https://github.com/nansen-ai/nansen-cli/pull/129) [`eeabf89`](https://github.com/nansen-ai/nansen-cli/commit/eeabf8988dafc7fb1964fd2eef629f03c6a4420a) Thanks [@araa47](https://github.com/araa47)! - Fix `trade quote` crash when no wallet exists — now shows actionable error instead of uncaught exception

- [#126](https://github.com/nansen-ai/nansen-cli/pull/126) [`f3b87e7`](https://github.com/nansen-ai/nansen-cli/commit/f3b87e7491d03d052d5d72fcc991de0c33caf51f) Thanks [@araa47](https://github.com/araa47)! - Remove root SKILL.md so `npx skills add nansen-ai/nansen-cli` correctly discovers all 7 skills in `skills/` instead of treating the repo as a single skill.

## 1.9.3

### Patch Changes

- [#118](https://github.com/nansen-ai/nansen-cli/pull/118) [`0bd4c3c`](https://github.com/nansen-ai/nansen-cli/commit/0bd4c3c1946e575e2c2db5e02d17f266e79752a4) Thanks [@TimNooren](https://github.com/TimNooren)! - Show warning when trade quote price impact exceeds 5%, and show pin command to avoid fallback to worse quotes

## 1.9.2

### Patch Changes

- [#116](https://github.com/nansen-ai/nansen-cli/pull/116) [`7a2b729`](https://github.com/nansen-ai/nansen-cli/commit/7a2b7293c2e731ae1d5375b15df9c05c5611a9cb) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix usage examples for `nansen trade quote` to show correct command name instead of deprecated `nansen quote`

- [#114](https://github.com/nansen-ai/nansen-cli/pull/114) [`37d8c0b`](https://github.com/nansen-ai/nansen-cli/commit/37d8c0b87797145a15b087caa5eb474673217580) Thanks [@TimNooren](https://github.com/TimNooren)! - Show API key URL in non-interactive login error message

- [#117](https://github.com/nansen-ai/nansen-cli/pull/117) [`55ad922`](https://github.com/nansen-ai/nansen-cli/commit/55ad922826a7a2411889edeede42fbfc7b70d7a5) Thanks [@TimNooren](https://github.com/TimNooren)! - Add --wallet and WalletConnect documentation to `nansen trade help` output

## 1.9.1

### Patch Changes

- [#110](https://github.com/nansen-ai/nansen-cli/pull/110) [`82aa780`](https://github.com/nansen-ai/nansen-cli/commit/82aa78022bdcd62987b0949e090f19f563699d9a) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix `nansen changelog` always showing "CHANGELOG.md not found". Added a `files` field to `package.json` to explicitly bundle `CHANGELOG.md` with the published package. Also excludes `src/__tests__/` from the package, reducing package size from ~537 kB to ~269 kB.

## 1.9.0

### Minor Changes

- [#98](https://github.com/nansen-ai/nansen-cli/pull/98) [`2f3f556`](https://github.com/nansen-ai/nansen-cli/commit/2f3f556d008a1f8ec40d57a8a2822bedbc6b60cb) Thanks [@Codier](https://github.com/Codier)! - Add symbol shortcuts for common tokens (SOL, ETH, USDC, USDT, etc.) that resolve to canonical addresses per chain. Users can now use `--from SOL --to USDC` instead of raw contract addresses.

- [#32](https://github.com/nansen-ai/nansen-cli/pull/32) [`08a8d21`](https://github.com/nansen-ai/nansen-cli/commit/08a8d21be6e9196661be737545e790af180aebc3) Thanks [@arein](https://github.com/arein)! - Add WalletConnect support for trading, transfers, and x402 auto-payment (EVM only)

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
