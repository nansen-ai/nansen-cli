---
name: nansen-alerts
description: Configure and check Smart Money Netflow alerts using the nansen CLI. Use when a user wants to: (1) set up an alert for smart money buying/selling a token, (2) list, edit, enable, disable, or delete existing alerts, (3) check whether any alerts would currently fire, (4) be notified in Telegram/Slack/Discord when smart money flows cross a threshold on any chain.
---

# Nansen Smart Money Netflow Alerts

Alerts are stored in `alerts.json` (same directory as this file). The agent reads and writes this file to manage alerts, then polls on heartbeat/cron and sends a notification when a condition is met.

See `references/schema.md` for the full alert config schema, field reference, and example mappings from natural language to config.
See `references/polling.md` for the step-by-step polling and notification logic.

---

## CRUD Operations

### Create
1. Read `alerts.json` (treat missing file as `[]`)
2. Translate user intent → config using the mapping table in `references/schema.md`
3. Append new entry, write back
4. Confirm: *"Alert created: [name]. Will fire when [condition] on [chain]."*

### List
Read `alerts.json`, display: id, name, chain, condition, enabled, last_fired_at.

### Edit / Delete / Toggle
Find by `id` or `name`, update or remove, write back.

---

## Checking Alerts (Polling)

For each enabled alert in `alerts.json`:

1. Run: `nansen research smart-money netflow --chain <chain> [--labels '<labels>'] --limit 50`
2. Parse `response.data.data` — filter rows by `token_symbol` if set
3. Evaluate: `row[condition.field] <op> condition.value`
4. If triggered AND `now - last_fired_at >= cooldown_minutes`: send notification, update `last_fired_at`

See `references/polling.md` for full details including the notification message format.

---

## Supported Chains
`ethereum`, `solana`, `base`, `bnb`, `arbitrum`, `polygon`, `optimism`, `avalanche`, `linea`, `scroll`, `mantle`, `ronin`, `sei`, `plasma`, `sonic`, `monad`, `hyperevm`, `iotaevm`

## Supported Smart Money Labels
`Fund`, `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `180D Smart Trader`, `Smart HL Perps Trader`
