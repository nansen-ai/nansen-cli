---
name: nansen-sm-holdings
description: What smart money holds right now — aggregated SM portfolios, historical positions over time, and Jupiter DCA strategies. Use when tracking SM conviction via portfolio composition rather than individual trades.
---

# Smart Money Holdings

```bash
CHAIN=solana

# Current aggregated SM portfolio
nansen research smart-money holdings --chain $CHAIN --labels "Smart Trader" --limit 10
# → token_symbol, value_usd, holders_count, balance_24h_percent_change, share_of_holdings_percent

# Filter by label
nansen research smart-money holdings --chain $CHAIN --labels "Fund" --limit 10

# Historical SM positions over time
nansen research smart-money historical-holdings --chain $CHAIN --days 30
# → date, token_symbol, value_usd, holders_count

# Jupiter DCA strategies (Solana only, no --chain needed)
nansen research smart-money dcas --limit 20
# → trader_address, trader_address_label, input/output_token_symbol, deposit_value_usd, dca_status, dca_created_at
```

Labels: `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `Fund`, `Smart HL Perps Trader`

`dcas` is Solana-only (Jupiter). No `--chain` flag.
Rising share_of_holdings + positive historical trend = sustained conviction.
DCA orders = long-horizon accumulation — higher signal than single trades.
