---
name: nansen-sm-trades
description: Real-time SM trade activity — live DEX spot trades and Hyperliquid perp trades by smart money wallets. Use when monitoring what SM is actively buying/selling right now.
---

# Smart Money Trades (Live Activity)

```bash
CHAIN=solana

# Live spot DEX trades by SM wallets
nansen research smart-money dex-trades --chain $CHAIN --labels "Smart Trader" --limit 20
# → block_timestamp, trader_address_label, token_bought_symbol, token_sold_symbol,
#   token_bought_amount, token_sold_amount, trade_value_usd

# Filter by label
nansen research smart-money dex-trades --chain $CHAIN --labels "Fund" --limit 20

# Hyperliquid perp trades (no --chain needed — Hyperliquid only)
nansen research smart-money perp-trades --limit 20
# → token_symbol, side, action (Open/Close), value_usd, price_usd, trader_address_label
```

Labels: `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `Fund`, `Smart HL Perps Trader`

`perp-trades` does not support `--chain` or `--labels` — returns all SM perp traders on Hyperliquid.
For accumulation trends (not just live trades), use `nansen-sm-signals` (netflow) or `nansen-sm-holdings`.
For deeper individual trade history per wallet, use `nansen-profiler-history`.
