---
name: nansen-x
description: X (Twitter) post analytics — posts mentioning a token or from a specific user. Use when researching social sentiment, tracking influencer activity, or pairing X chatter with on-chain smart money signals.
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

# X (Twitter) Post Analytics

All commands: `nansen research x <sub> [options]`

## Subcommands

```bash
# Posts mentioning a token — by symbol or name
nansen research x posts-by-token --token-symbol BTC --days 7 --sort likes:desc --limit 20

# Posts by a specific user
nansen research x posts-by-user --username vitalikbuterin --days 7 --min-likes 10
```

## Flags

| Flag | Purpose |
|------|---------|
| `--token-symbol` | Filter posts by token ticker (e.g. `BTC`, `ETH`) |
| `--token-name` | Filter posts by token name (e.g. `Bitcoin`) |
| `--username` | X username for `posts-by-user` (required) |
| `--days` | Look-back window in days (default: 7) |
| `--min-likes` | Minimum likes threshold |
| `--min-views` | Minimum views threshold |
| `--sort` | Sort field:direction (e.g. `likes:desc`, `views:desc`) |
| `--limit` | Number of results |
| `--json` | Machine-readable JSON output (clean, no warnings on stdout) |

## Returns

Each post: `username`, `timestamp`, `text`, `likes`, `views`, `tweet_id`

## Notes

- Pair with `nansen research smart-money netflow` to correlate social buzz with on-chain accumulation.
- `posts-by-token` accepts either `--token-symbol` or `--token-name`; symbol is preferred when available.
- `--json` output is clean (deprecation/update notices go to stderr only).
