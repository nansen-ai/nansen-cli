# Polling & Notification Logic

## CLI Command

```bash
nansen research smart-money netflow \
  --chain <chain> \
  [--labels '<label1>,<label2>'] \
  --limit 50
```

Omit `--labels` when `alert.labels` is null.

## Response Shape

```json
{
  "success": true,
  "data": {
    "data": [
      {
        "token_symbol": "SYRUP",
        "net_flow_1h_usd": 85000,
        "net_flow_24h_usd": 419795,
        "net_flow_7d_usd": 419795,
        "chain": "ethereum",
        "trader_count": 3,
        "market_cap_usd": 270029974,
        "token_address": "0x..."
      }
    ]
  }
}
```

## Evaluation Logic

```
rows = response.data.data

if alert.token_symbol is set:
    rows = rows.filter(r => r.token_symbol === alert.token_symbol)

triggered = rows.filter(r => eval(r[condition.field] <op> condition.value))
```

## Cooldown Check

```
if triggered.length > 0:
    if last_fired_at is null OR (now - last_fired_at) >= cooldown_minutes * 60s:
        → fire notification
        → update last_fired_at = now in alerts.json
    else:
        → skip (within cooldown)
```

## Notification Format

Send to `alert.notify_chat_id` via Telegram for each triggered token:

```
🚨 Smart Money Alert: <alert.name>

Token: <token_symbol> (<chain>)
Condition: <field> <op> $<value>
Actual: $<actual_value formatted with commas>
Traders: <trader_count> smart money wallets
Market Cap: $<market_cap in M>M

nansen research smart-money netflow --chain <chain>
```

## Dry Run

To test without notifying: run the CLI command, evaluate conditions, report which tokens would fire — but do NOT send notifications and do NOT update `last_fired_at`.
