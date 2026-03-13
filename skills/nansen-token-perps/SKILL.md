---
name: nansen-token-perps
description: Perp activity for a specific token — SM perp trades, open positions, PnL leaderboard, and Jupiter DCA strategies. Use when checking derivatives sentiment or whale conviction on a token.
---

# Token Perps & DCA

No `--chain` flag for perp commands — Hyperliquid only. No `--token` for perp endpoints — use `--symbol`.

```bash
SYMBOL=ETH  # use ticker, not address

# Recent SM perp trades on this token
nansen research token perp-trades --symbol $SYMBOL --days 7
# → timestamp, side (LONG/SHORT), action (Open/Close/Reduce), size, price_usd, value_usd, trader_address_label

# Current open positions by symbol
nansen research token perp-positions --symbol $SYMBOL --limit 20
# → address, address_label, side, position_value_usd, leverage, entry_price, mark_price, upnl_usd

# PnL leaderboard for this perp market
nansen research token perp-pnl-leaderboard --symbol $SYMBOL --days 30 --limit 20
# → trader_address, trader_address_label, pnl_usd_realised, roi_percent_total, nof_trades
```

```bash
# Jupiter DCA strategies targeting a Solana token (Solana only)
TOKEN=<solana_token_address>
nansen research token jup-dca --token $TOKEN
# → trader_address, trader_address_label, input/output_token_symbol, deposit_value_usd, dca_status, dca_created_at
```

Large open longs + SM perp traders = conviction. Longs + price decline = underwater risk. DCA orders = long-horizon SM accumulation.
