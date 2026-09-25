---
name: nansen-web-fetcher
description: Fetch and analyze content from one or more URLs using AI (Gemini 2.5 Flash). Use when you have specific URLs and need to extract or summarize their content. Pairs well with `nansen web search` results.
metadata:
  openclaw:
    requires:
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---
## Authentication

Nansen account API calls accept a selected `nansen:api` browser session or conventional API key with the same permissions. `NANSEN_API_KEY` takes precedence; optional `primaryEnv` preserves configured-key injection. Run `nansen auth status` for offline selection. Cached access expiry alone permits automatic renewal during an authorized task. Stop on anonymous selection, invalid state, blocked/uncertain renewal or actual auth failure; never drop a credential or fall back to anonymous x402 payment. Browser login does not grant wallet signing, privileged service identity or a persistent MCP integration key. Preserve all confirmation, signing, sanctions and geographic checks below. Browser rollout acceptance is still pending.



# Web Fetch

Fetch and analyze content from one or more URLs using Gemini 2.5 Flash with URL context.

```bash
nansen web fetch https://nansen.ai --question "What products does Nansen offer?"
nansen web fetch --url https://example.com --url https://other.com --question "Compare these two sites"
nansen web fetch https://docs.uniswap.org/contracts/v4/overview --question "What changed in v4?"
```

Positional args and `--url` flags can be combined — all become URLs to fetch.

| Flag | Values | Default | Purpose |
|------|--------|---------|---------|
| `--url` | URL | — | URL to fetch (repeatable for multiple URLs, up to 20) |
| `--question` | string | **required** | Question to answer about the URL content |
| `--pretty` | flag | off | Human-readable JSON |

Returns:
- `analysis` — AI-generated answer to your question
- `retrieved_urls` — URLs successfully fetched
- `failed_urls` — URLs that could not be retrieved

**Tip:** Combine with `web search` — search first to find relevant URLs, then fetch to get full content.

```bash
# Find and analyze in two steps
nansen web search "uniswap v4 launch" --num-results 3 --fields link
nansen web fetch https://blog.uniswap.org/... --question "What are the key changes?"
```

**Note:** 30s timeout. Paywalled or bot-blocked pages may appear in `failed_urls`.
