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
nansen alerts list --pretty
```

## Create

```bash
nansen alerts create --name "ETH SM Flows" --type sm-token-flows --time-window 1h --chains ethereum --telegram 5238612255 --data '{"events":["sm-token-flows"],"inclusion":{"tokens":[{"chain":"ethereum","address":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"}]},"exclusion":{},"inflow_1h":{"min":100000},"inflow_1d":{},"inflow_7d":{},"outflow_1h":{},"outflow_1d":{},"outflow_7d":{}}' --pretty
```

## Update

```bash
nansen alerts update --id <alert-id> --name "New Name" --pretty
```

All create options are optional for update (only `--id` is required).

## Toggle

```bash
nansen alerts toggle --id <alert-id> --enabled
nansen alerts toggle --id <alert-id> --disabled
```

## Delete

```bash
nansen alerts delete --id <alert-id>
```

## Options Reference

| Flag | Create | Update | Toggle | Delete |
|------|--------|--------|--------|--------|
| `--id` | | required | required | required |
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

- `sm-token-flows` — Smart money token flow alerts
- `common-token-transfer` — Common token transfer alerts

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
- `--channels` and `--data` accept JSON strings.
- `list` returns an array directly.
