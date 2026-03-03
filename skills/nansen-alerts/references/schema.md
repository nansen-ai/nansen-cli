# Alert Config Schema

## alerts.json entry

```json
{
  "id": "sm-eth-any-1h",
  "name": "ETH Smart Money Surge (1h)",
  "enabled": true,
  "chain": "ethereum",
  "labels": null,
  "token_symbol": null,
  "condition": {
    "field": "net_flow_1h_usd | net_flow_24h_usd | net_flow_7d_usd",
    "op": "> | < | >= | <=",
    "value": 500000
  },
  "cooldown_minutes": 60,
  "last_fired_at": null,
  "notify_chat_id": "-5201043873"
}
```

- `labels`: array of smart money label strings, or `null` for all
- `token_symbol`: specific token ticker, or `null` to match any token
- `notify_chat_id`: Telegram chat ID; use current chat ID if not specified by user

## API Response Fields

| Field | Description |
|---|---|
| `net_flow_1h_usd` | Net USD flow last 1 hour |
| `net_flow_24h_usd` | Net USD flow last 24 hours |
| `net_flow_7d_usd` | Net USD flow last 7 days |
| `token_symbol` | Token ticker |
| `token_address` | Contract/mint address |
| `market_cap_usd` | Token market cap |
| `trader_count` | Number of smart money wallets active |
| `chain` | Chain name |

## Natural Language → Config Mappings

| User says | chain | token_symbol | field | op | value |
|---|---|---|---|---|---|
| "smart money buys > $500K of any ETH token in 1h" | ethereum | null | net_flow_1h_usd | > | 500000 |
| "smart money dumps SYRUP > $200K in 24h" | ethereum | SYRUP | net_flow_24h_usd | < | -200000 |
| "Funds accumulate SOL tokens > $1M in a week" | solana | null | net_flow_7d_usd | > | 1000000 |
| "any smart money flow > $100K on base in 1h" | base | null | net_flow_1h_usd | > | 100000 |
| "smart money selling ETH > $500K 24h" | ethereum | ETH | net_flow_24h_usd | < | -500000 |

**Note on sell alerts:** selling = negative net flow, so use `<` with a negative value (e.g. `< -200000`).

## Default values
- `cooldown_minutes`: 60
- `labels`: null (all smart money)
- `token_symbol`: null (any token)
