# Skills Breakdown Analysis — Mando (Dan Magowan's Claw)

## Summary

15 new granular skills added. All under 20 lines. All commands verified against the CLI schema.

The breakdown targets 5 monolithic reference skills that exceed the 30-line threshold and cover multiple unrelated workflows. Granular task-specific skills already exist (e.g. `nansen-sm-signals`, `nansen-token-analysis`) — this PR fills the gaps and completes the pattern.

---

## Problem: Skills Too Large to Follow Reliably

| Skill | Lines | Issue |
|-------|-------|-------|
| `nansen-wallet-migration` | 183 | 4 divergent paths, but all genuinely needed — kept as is |
| `nansen-wallet` | 140 | Auth setup + create + send + manage all mixed together |
| `nansen-token` | 114 | 10+ subcommands across screener, OHLCV, holders, flows, perps, DCA |
| `nansen-profiler` | 98 | Identity + PnL + history + relationships + perps + batch in one file |
| `nansen-trade` | 95 | Acceptable — safety content justifies length |
| `nansen-prediction-market` | 92 | Screener + market depth + trades + PnL all combined |
| `nansen-smart-money` | 79 | Holdings + live trades + DCAs + perps conflated |

---

## New Skills Added

### nansen-wallet → 3 skills

| New Skill | What It Does | Lines |
|-----------|-------------|-------|
| `nansen-wallet-create` | 2-step creation flow with password safety rules | 19 |
| `nansen-wallet-send` | Send native tokens (with dry-run) | 18 |
| `nansen-wallet-manage` | List, show, export, delete, forget-password, secure | 17 |

### nansen-token → 3 new granular skills (to complement existing token-analysis, token-forensics, token-indicators, token-pnl)

| New Skill | What It Does | Lines |
|-----------|-------------|-------|
| `nansen-token-screener` | Screener by volume, SM filter, search | 14 |
| `nansen-token-ohlcv` | OHLCV price candles | 12 |
| `nansen-token-perps` | Token perp-trades, perp-positions, perp-pnl-leaderboard, jup-dca | 18 |

### nansen-profiler → 4 new granular skills

| New Skill | What It Does | Lines |
|-----------|-------------|-------|
| `nansen-profiler-identity` | Labels, balance, name search | 16 |
| `nansen-profiler-pnl` | PnL per token, summary, historical balances | 17 |
| `nansen-profiler-history` | Transactions, counterparties, related-wallets | 17 |
| `nansen-profiler-perps` | Perp positions + trades for a wallet | 15 |

### nansen-prediction-market → 3 new granular skills

| New Skill | What It Does | Lines |
|-----------|-------------|-------|
| `nansen-pm-screener` | Event + market screener + categories | 18 |
| `nansen-pm-depth` | OHLCV + orderbook + holders + positions for one market | 17 |
| `nansen-pm-activity` | Trades + PnL by market and by address | 18 |

### nansen-smart-money → 2 new granular skills (to complement existing sm-signals, sm-trend)

| New Skill | What It Does | Lines |
|-----------|-------------|-------|
| `nansen-sm-holdings` | Holdings, historical-holdings, Jupiter DCAs | 18 |
| `nansen-sm-trades` | Live DEX trades + Hyperliquid perp trades | 17 |

---

## What Was Kept

These skills are well-scoped and meet the criteria already:

- `nansen-batch-wallet` (13 lines) ✓
- `nansen-cross-chain-flow` (14 lines) ✓
- `nansen-token-indicators` (14 lines) ✓
- `nansen-wallet-compare` (17 lines) ✓
- `nansen-sm-trend` (17 lines) ✓
- `nansen-sm-signals` (23 lines) ✓
- `nansen-token-pnl` (23 lines) ✓
- `nansen-alpha-discovery` (25 lines) ✓
- `nansen-perp-scan` (23 lines) ✓
- `nansen-perp-trader` (26 lines) ✓
- `nansen-polymarket-trader` (36 lines) ✓

The monolithic reference skills (`nansen-token`, `nansen-wallet`, `nansen-profiler`, `nansen-smart-money`, `nansen-prediction-market`) are retained as they provide a useful overview. The new granular skills are what Claws should load for specific tasks.

---

## Design Principles Applied

1. **One question per skill.** Each skill answers one question a user might actually ask.
2. **Commands verified.** Every command in the new skills exists in `nansen schema` output.
3. **Gotchas preserved.** Key traps (no `--chain` for perps, pagination patterns, `labels` no `--limit`) carried over from the reference skills.
4. **Cross-references not duplication.** Skills point to each other rather than repeating commands.
5. **`nansen-wallet-migration` kept whole.** The 4 migration paths are interdependent — detecting state drives which path to take. Splitting would force the Claw to load all parts anyway.
