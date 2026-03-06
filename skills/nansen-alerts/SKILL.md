---
name: nansen-alerts
description: Manage smart alerts — list, create, update, toggle, delete. Use when setting up or managing token flow alerts, smart money alerts, or notification rules.
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_API_KEY
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---

# Smart Alerts

CRUD management for smart alerts. Alerts are internal-only (requires Nansen internal API key).

## List

```bash
nansen alerts list --table
```

## Create

```bash
nansen alerts create --name "ETH SM Flows" --type sm-token-flows --time-window 1h --chains ethereum --telegram 5238612255 --data '{"events":["sm-token-flows"],"inclusion":{"tokens":[{"chain":"ethereum","address":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"}]},"exclusion":{},"inflow_1h":{"min":100000},"inflow_1d":{},"inflow_7d":{},"outflow_1h":{},"outflow_1d":{},"outflow_7d":{}}' --pretty
```

## Update

```bash
nansen alerts update <alert-id> --name "New Name" --pretty
```

All create options are optional for update (only `<alert-id>` is required as first positional arg).

## Toggle

```bash
nansen alerts toggle <alert-id> --enabled
nansen alerts toggle <alert-id> --disabled
```

## Delete

```bash
nansen alerts delete <alert-id>
```

## Options Reference

| Flag | Create | Update | Toggle | Delete |
|------|--------|--------|--------|--------|
| `<id>` (positional) | | required | required | required |
| `--name` | required | optional | | |
| `--type` | required | optional | | |
| `--time-window` | required | optional | | |
| `--chains` | recommended | optional | | |
| `--telegram` | chat ID | optional | | |
| `--slack` | webhook URL | optional | | |
| `--discord` | webhook URL | optional | | |
| `--data` | optional (JSON) | optional (JSON) | | |
| `--description` | optional | optional | | |
| `--enabled` | | flag | flag | |
| `--disabled` | flag | flag | flag | |

## Alert Types

Three alert types are supported, each with a different `--data` schema:

### 1. `sm-token-flows` — Smart Money Token Flows

Track Smart Money aggregated inflow/outflow over time windows. At least one time window threshold must be specified.

**Required fields:**
- `--name`: Alert title
- `--type sm-token-flows`
- `--time-window 1h` (fixed for this type)
- At least one channel (`--telegram`, `--slack`, or `--discord`)

**Data schema:**
```json
{
  "chains": ["ethereum", "solana", "base", ...],
  "inflow_1h": { "min": 5000000, "max": null },
  "inflow_1d": { "min": null, "max": null },
  "inflow_7d": { "min": null, "max": null },
  "outflow_1h": { "min": null, "max": null },
  "outflow_1d": { "min": null, "max": null },
  "outflow_7d": { "min": null, "max": null },
  "netflow_1h": { "min": null, "max": null },
  "netflow_1d": { "min": null, "max": null },
  "netflow_7d": { "min": null, "max": null },
  "inclusion": {
    "tokens": [
      { "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "chain": "ethereum" }
    ],
    "tokenSectors": ["DeFi", "Gaming"],
    "marketCap": { "min": 1000000, "max": 100000000 },
    "fdv": { "min": null, "max": null }
  },
  "exclusion": {
    "tokens": [],
    "tokenSectors": ["Meme"]
  }
}
```

**Field descriptions:**
- `chains`: Array of chain names. Use `["all"]` if not specified.
- `inflow_*` / `outflow_*` / `netflow_*`: USD thresholds for time windows (1h, 1d, 7d). Use `inflow` to track smart money buying/receiving, `outflow` for selling/sending. Min/max must be positive numbers.
- `inclusion.tokens`: Specific tokens to monitor. Empty array tracks all tokens.
- `inclusion.tokenSectors`: Token sectors to monitor. Empty array tracks all sectors.
- `inclusion.marketCap` / `fdv`: Market cap / FDV range filters (USD).
- `exclusion`: Tokens/sectors to ignore.

**Example:**
```bash
nansen alerts create \
  --name "Smart Money ETH Buying Alert" \
  --type sm-token-flows \
  --time-window 1h \
  --chains ethereum \
  --telegram 5238612255 \
  --description 'Alert when smart money inflow exceeds $5M in 1 hour for ETH' \
  --data '{
    "chains": ["ethereum"],
    "inflow_1h": {"min": 5000000},
    "inclusion": {
      "tokens": [{"address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "chain": "ethereum"}]
    }
  }'
```

### 2. `common-token-transfer` — Token Transfer Events

Track real-time token transfer events on the blockchain. Triggers when transfers match your specified criteria.

**Required fields:**
- `--name`: Alert title
- `--type common-token-transfer`
- `--time-window realtime` (fixed for this type)
- At least one channel

**Data schema:**
```json
{
  "subjects": [
    { "type": "address|entity|label|custom-label", "value": "0x..." }
  ],
  "chains": ["ethereum", "solana", ...],
  "events": ["buy", "sell", "swap", "send", "receive"],
  "counterparties": [
    { "type": "address|entity|label|custom-label", "value": "CEX" }
  ],
  "usdValue": { "min": 1000000, "max": null },
  "tokenAmount": { "min": 100, "max": null },
  "inclusion": {
    "tokens": [
      { "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "chain": "ethereum" }
    ],
    "tokenSectors": ["DeFi"],
    "tokenAge": { "min": 7, "max": 365 },
    "marketCap": { "min": 1000000, "max": null }
  },
  "exclusion": {
    "tokens": [],
    "tokenSectors": [],
    "tokenAge": { "min": null, "max": null }
  }
}
```

**Field descriptions:**
- `subjects`: The addresses/entities/labels to track. Empty array tracks all addresses. Required if `counterparties` is specified.
- `chains`: Blockchain networks to monitor.
- `events`: Transaction types to track:
  - `buy`: Token swapped from native/stablecoin to other token
  - `sell`: Token swapped to native/stablecoin
  - `swap`: Any token-to-token swap
  - `send`: Outgoing transfer
  - `receive`: Incoming transfer
  - Empty array tracks all events
- `counterparties`: Secondary targets (e.g., CEX, specific wallets). Can only be set when `subjects` is specified. Prefer using `subjects` with opposite event direction.
- `usdValue` / `tokenAmount`: Value/quantity thresholds. Empty object `{}` tracks all values.
- `inclusion.tokens`: Specific tokens to monitor. Empty array tracks all tokens.
- `inclusion.tokenAge`: Token age range in days.
- `inclusion.marketCap`: Market cap range (USD).
- `exclusion`: Filters to exclude from alerts.

**Important notes:**
- The `buy` event for counterparties = `sell` event for subjects
- The `send` event for counterparties = `receive` event for subjects
- To track "any addresses sending to CEX", use `subjects` with `receive` event, NOT `counterparties` with `send` event

**Example:**
```bash
nansen alerts create \
  --name "Large USDC Transfers Alert" \
  --type common-token-transfer \
  --time-window realtime \
  --chains ethereum \
  --telegram 123456789 \
  --description 'Alert when USDC transfers exceed $1M on Ethereum mainnet' \
  --data '{
    "chains": ["ethereum"],
    "events": ["send", "receive"],
    "inclusion": {
      "tokens": [
        {"address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "chain": "ethereum"}
      ]
    },
    "usdValue": {"min": 1000000}
  }'
```

### 3. `smart-contract-call` — Smart Contract Interactions

Track smart contract call events when the system detects contract interactions matching your criteria.

**Required fields:**
- `--name`: Alert title
- `--type smart-contract-call`
- `--time-window realtime` (fixed for this type)
- At least one channel

**Data schema:**
```json
{
  "chains": ["ethereum", "base", ...],
  "usdValue": { "min": 100000, "max": null },
  "signatureHash": ["0x095ea7b3", "0xa9059cbb"],
  "inclusion": {
    "caller": [
      { "type": "address|entity|label|custom-label", "value": "0x..." }
    ],
    "smartContract": [
      { "type": "address|entity|label|custom-label", "value": "Uniswap V3" }
    ],
    "tokenIn": [
      { "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "chain": "ethereum" }
    ],
    "tokenOut": []
  },
  "exclusion": {
    "caller": [],
    "smartContract": [],
    "tokenIn": [],
    "tokenOut": []
  }
}
```

**Field descriptions:**
- `chains`: Blockchain networks to monitor.
- `usdValue`: USD value threshold for contract calls. Empty object `{}` tracks all values.
- `signatureHash`: Function signature hashes to monitor (e.g., `0x095ea7b3` for `approve`). Empty array tracks all function calls.
- `inclusion.caller`: Caller addresses/entities/labels to track. Empty array tracks all callers.
- `inclusion.smartContract`: Contract addresses/entities/labels to monitor. Empty array tracks all contracts.
- `inclusion.tokenIn` / `tokenOut`: Input/output tokens involved in the call.
- `exclusion`: Callers/contracts/tokens to ignore.

**Example:**
```bash
nansen alerts create \
  --name "Uniswap V3 Large Swaps" \
  --type smart-contract-call \
  --time-window realtime \
  --chains ethereum \
  --telegram 123456789 \
  --description 'Alert on large swaps through Uniswap V3' \
  --data '{
    "chains": ["ethereum"],
    "usdValue": {"min": 1000000},
    "inclusion": {
      "smartContract": [{"type": "entity", "value": "Uniswap V3"}]
    }
  }'
```

## Channels

Shorthand flags (preferred):
```bash
--telegram 123456
--slack https://hooks.slack.com/services/...
--discord https://discord.com/api/webhooks/...
```

Multiple channels can be combined: `--telegram 123 --slack https://...`


## Notes

- Alert endpoints are internal-only. Non-internal users receive 404.
- `--data` accepts a JSON string.
- `list` returns an array directly.
