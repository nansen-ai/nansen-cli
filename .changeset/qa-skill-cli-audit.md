---
"nansen-cli": patch
---

fix(skills): QA audit — 8 documentation bugs fixed via live API testing

Systematic audit of all 27 workflow skills against the live Nansen API
(52 test calls). Five skills had documentation bugs; all fixed.

### nansen-search
- **Fix:** Address lookup example removed — `nansen research search "0x..."` returns 0 results. Correct pattern is `profiler labels`.
- **Fix:** `--table` flag removed from docs — not a valid flag on this command.
- **Fix:** Description corrected from "by name or address" to "by name".
- Added explicit note: "Does NOT match by address — use `profiler labels`".

### nansen-wallet-attribution
- **Fix:** `profiler compare` does NOT return `overlap_score`. Actual return fields: `shared_counterparties`, `shared_tokens`, `balances`. Removed false field from docs.
- **Fix:** `CHAIN=ethereum` was a hardcoded value, not a placeholder. Fixed to `CHAIN=<ethereum|solana|base|...>` to make chain detection requirement unambiguous for agents.
- **Trim:** 75 → 30 lines. Detail moved to new `REFERENCE.md` companion (expansion protocol, attribution rules, confidence table).

### nansen-token-indicators
- **Fix:** Score values were missing `"high"`. Full set confirmed via live API: `bullish / bearish / neutral / high / medium / low`.

### nansen-token-analysis
- **Fix:** `flow-intelligence` comment listed 5 labels but API returns 6. Missing label: `top_pnl`. Missing field per label: `avg_flow_usd`.

### AGENTS.md
- Added 3 new endpoint quirks:
  - `smart-money netflow --timeframe` is silently ignored (ghost flag)
  - `nansen research search` by raw address returns 0 results — use `profiler labels`
  - `--chain bnb` resolves to `bsc` in response `chain` field
