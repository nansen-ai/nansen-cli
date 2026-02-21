# AGENTS.md — Agent Quick Start

> **This file is for AI agents (OpenClaw, Claude Code, Cursor, etc.) that need to query Nansen data on behalf of their human.** If you're a human, see [README.md](README.md).

## CLI vs REST API — Pick the Right Tool

**If you have HTTP access (curl, fetch, etc.):** Use the [REST API](https://docs.nansen.ai) directly — it's simpler, has no install step, and avoids CLI dependency issues.

```bash
# Direct API call — no CLI needed
curl -s -X POST https://api.nansen.ai/api/v1/token-screener \
  -H "apiKey: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","pagination":{"page":1,"per_page":5}}' | jq .
```

**If you're in a terminal-native context (Claude Code, Codex, Cursor):** The CLI adds convenience with `--pretty`, `--table`, `--fields`, `--stream`, built-in retries, and schema introspection.

**Rule of thumb:** Agents with `exec` + `curl` (like OpenClaw) → use the API. Coding agents working inside repos → the CLI is handy.

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
mkdir -p ~/.nansen && echo '{"apiKey":"<key>","baseUrl":"https://api.nansen.ai"}' > ~/.nansen/config.json && chmod 600 ~/.nansen/config.json
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
nansen schema | head -1
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

## Pagination

The CLI exposes `--limit N` which maps to `{page: 1, per_page: N}` in the API request. **There is no `--page` flag** — the CLI always fetches page 1. To access later pages, use the REST API directly.

```bash
# CLI: page 1 only, up to N results
nansen smart-money netflow --chain solana --limit 50

# REST API: full pagination control
curl -s -X POST https://api.nansen.ai/api/v1/smart-money/netflow \
  -H "apiKey: $NANSEN_API_KEY" -H "Content-Type: application/json" \
  -d '{"chains":["solana"],"pagination":{"page":2,"per_page":50}}'
```

**Pagination key inconsistency:** Profiler endpoints (which use the beta API) take `recordsPerPage` instead of `per_page`. The CLI sends the right key automatically based on the command, but if you're calling the REST API directly, check which key each endpoint expects.

**Detecting the last page:** The raw API response does not include a `total_pages` or `has_more` field in the CLI-visible output. Reliable heuristic: if the number of results returned is less than your `--limit`, you're on the last page.

```bash
# Request 50, get 23 back → last page
nansen token holders --token <addr> --chain solana --limit 50
# Check: .data.data.length (or .data.results.length) < 50 → done
```

**`profiler perp-positions` has no pagination** — the API ignores the pagination parameter for this endpoint.

## Output Parsing Gotchas

### Response envelope

Every CLI response is wrapped in a standard envelope:

```json
{ "success": true, "data": <raw_api_response> }
```

Errors follow a different shape:

```json
{ "success": false, "error": "message", "code": "ERROR_CODE", "status": 401, "details": {...} }
```

### Raw API response shapes vary by endpoint

The `data` field inside the envelope is the raw JSON from the Nansen API. Its internal structure differs across endpoints — there is no single canonical key for the results array:

| Shape | Example endpoints |
|-------|------------------|
| `data.data` (array) | token screener |
| `data.results` (array) | entity search |
| `data.data.results` (array) | most profiler endpoints |
| `data.netflows` | smart-money netflow |
| `data.trades` | smart-money dex-trades |
| `data.holdings` | smart-money holdings |
| `data.holders` | token holders |

When parsing, check for the array at each level. `--table` and `--stream` handle this automatically, but if you're parsing raw JSON with `jq`, probe the shape first:

```bash
nansen smart-money netflow --chain solana | jq 'keys, .data | keys'
```

### `--fields` applies to the entire response tree

`--fields token_symbol,net_flow_usd` strips everything except those keys from the **entire** response, including the `success` and `data` wrapper fields. The result will be a bare object containing only the matched keys found anywhere in the tree.

### Client-side vs server-side filtering

`token screener --search <term>` is **client-side**: the CLI fetches up to 500 results from the server, then filters locally. Set `--limit` higher than your expected result count when using `--search`.

### Fields absent for some chain/token combinations

Some fields are only populated for specific chains or tokens:
- `smart_money_holders` — absent for tokens without smart money tracking
- Flow intelligence fields — may all be `0` for illiquid tokens (not an error)
- Perp endpoints (`--symbol`) only work for Hyperliquid; `--token` is for on-chain tokens

## Chains Quick Reference

`ethereum` `solana` `base` `bnb` `arbitrum` `polygon` `optimism` `avalanche` `linea` `scroll` `mantle` `ronin` `sei` `plasma` `sonic` `monad` `hyperevm` `iotaevm`

> Run `nansen schema` to get the current chain list (source of truth).

## Troubleshooting

### Quick fixes

| Symptom | Fix |
|---------|-----|
| `command not found: nansen` | `npm install -g nansen-cli` or `npx nansen-cli` |
| `UNAUTHORIZED` after login | Check `cat ~/.nansen/config.json` — key may not have saved. Write it directly. |
| Login hangs or fails | Skip `nansen login`, write config directly (see Install & Auth above) |
| Huge JSON response | Use `--fields` to select only needed columns |
| Perp endpoints empty or erroring | Use `--symbol BTC` not `--token`. Perp endpoints are Hyperliquid-only. |
| JUP DCA returns error | Solana-only endpoint |
| `UNSUPPORTED_FILTER` on token holders | Not all tokens have smart money data. Remove `--smart-money` and retry. |
| `CREDITS_EXHAUSTED` | Stop all calls. Check [app.nansen.ai](https://app.nansen.ai). No retry will help. |

### Error codes

| Code | What to do |
|------|------------|
| `CREDITS_EXHAUSTED` | **Stop all calls.** Tell the human. Check dashboard. |
| `RATE_LIMITED` | Wait — auto-retry handles this by default. |
| `UNSUPPORTED_FILTER` | Remove the filter, retry without it. |
| `UNAUTHORIZED` | Key is wrong or missing. Re-auth. |
| `INVALID_ADDRESS` | Check address format matches the chain (EVM: `0x...`, Solana: Base58). |

### Known endpoint quirks

- **`token holders --smart-money`** — Fails with `UNSUPPORTED_FILTER` for tokens without smart money tracking (e.g., WCT on Optimism). Not all tokens have this data. Do not retry.
- **`token flow-intelligence`** — May return all-zero flows for tokens without significant smart money activity. Normal, not an error.
- **`profiler labels` and `profiler balance`** consume credits. Budget ~20 calls per session. Batch calls in groups of 3–4.
- **`profiler perp-positions`** — No pagination support; the API ignores the pagination parameter.

## For OpenClaw / Skill Users

If you installed this as an OpenClaw skill, the `SKILL.md` file has the skill interface. This `AGENTS.md` covers the CLI directly. Both work.
