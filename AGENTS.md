# AGENTS.md — Agent Quick Start

> **This file is for AI agents (OpenClaw, Claude Code, Cursor, etc.) that need to use nansen-cli on behalf of their human.** If you're a human, see [README.md](README.md).

## Install & Auth in One Shot

```bash
# Install
npm install -g nansen-cli

# Auth — pick ONE method:
# Method 1: Interactive (human needs to paste key)
nansen login

# Method 2: Environment variable (no interaction needed)
export NANSEN_API_KEY=<key>

# Method 3: Config file (write directly — no validation call burned)
mkdir -p ~/.nansen && echo '{"apiKey":"<key>","baseUrl":"https://api.nansen.ai"}' > ~/.nansen/config.json
```

**Get an API key:** [app.nansen.ai/api](https://app.nansen.ai/api)

### Auth Priority

1. `NANSEN_API_KEY` env var (highest)
2. `~/.nansen/config.json` file
3. Prompt (interactive only)

### Common Auth Pitfall

`nansen login` validates your key by making a real API call (burns 1 credit). If you already know the key is valid, writing `~/.nansen/config.json` directly is cheaper.

## Verify It Works

```bash
# This is cheap and fast:
nansen schema --pretty | head -5
# Expected: {"version":"1.x.x","commands":{...}}

# This burns a credit but proves API access:
nansen token screener --chain solana --limit 1
```

## Agent-Optimized Patterns

### 1. Always Use `--fields` to Reduce Token Burn

```bash
# ❌ Returns everything (huge JSON, wastes agent context)
nansen smart-money netflow --chain solana

# ✅ Only what you need
nansen smart-money netflow --chain solana --fields token_symbol,net_flow_usd,chain --limit 10
```

### 2. Use Schema for Self-Discovery

```bash
# Don't guess commands — introspect:
nansen schema --pretty                    # All commands
nansen schema smart-money --pretty        # One command's options & return fields
```

### 3. Parse Errors Programmatically

Every response has `success: true/false`. Errors include `code` for routing:

| Code | What To Do |
|------|------------|
| `CREDITS_EXHAUSTED` | **Stop all calls.** Tell the human. |
| `RATE_LIMITED` | Wait. Auto-retry handles this. |
| `UNSUPPORTED_FILTER` | Remove the filter, retry without it. |
| `UNAUTHORIZED` | Key is wrong. Re-auth. |
| `INVALID_ADDRESS` | Check address format for the chain. |

### 4. Budget Credits

- Most calls cost 1 credit
- `profiler labels` + `profiler balance` are expensive — batch 3-4 at a time
- `schema`, `help`, `cache` are free (no API key needed)
- If you get `CREDITS_EXHAUSTED`, **stop immediately** — don't retry

### 5. Use `--stream` for Large Results

```bash
# NDJSON mode — process line by line, don't buffer giant arrays
nansen token dex-trades --chain solana --limit 100 --stream
```

## Chains Quick Reference

`ethereum` `solana` `base` `bnb` `arbitrum` `polygon` `optimism` `avalanche` `linea` `scroll` `zksync` `mantle` `ronin` `sei` `sonic` `monad` `hyperevm`

## When Something Goes Wrong

1. **"command not found"** → `npm install -g nansen-cli` or use `npx nansen-cli`
2. **"unauthorized"** → Check `echo $NANSEN_API_KEY` or `cat ~/.nansen/config.json`
3. **"credits exhausted"** → Check [app.nansen.ai](https://app.nansen.ai), tell the human
4. **Perp endpoints return nothing** → Use `--symbol BTC` not `--token`, these are Hyperliquid-only
5. **JUP DCA returns error** → Solana-only endpoint

## For OpenClaw / Skill Users

If you installed this as an OpenClaw skill, the `SKILL.md` file has the skill interface. This `AGENTS.md` covers the CLI directly. Both work.
