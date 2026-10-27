---
"nansen-cli": minor
---

Every failure now exits 1 with `success: false`, and research commands check their input before calling the API (API-1080, API-1081).

- Subcommand typos (also with `--fields`) and unknown commands return `UNKNOWN_COMMAND` with the closest match, instead of `success: true` with the error inside `data`.
- Unknown options (`--turbo`), options a command used to ignore (`--limit` on `token ohlcv`, `--address` on `prediction-market position-detail`), options without a value (`--chain` with nothing after it), `--page 0`, `--format xml`, bad enum values and invalid dates (`--from-date 2024-13-45`) are rejected with the option named, in the REST API's wording ("Option '--timefrme' is not recognized by ... Did you mean '--timeframe'?").
- Missing required options (for example `--address`) fail locally instead of returning "API request failed (422)".
- `--chain`/`--chains` are checked against the chains each endpoint accepts; `nansen schema` lists them as `supportedChains`. Case and the API's chain aliases (`bsc`, `eth`, ...) are normalised first, as the API does. An invalid bitcoin token address now names native BTC (`1111111111111111111114oLvT2`).
- `--fields` names that match nothing in the response are an error instead of `{}`.
- `profiler balance` now sends `--limit`/`--page`, and `smart-money holdings --token` filters by token. Mixed-case EVM addresses in `--filters` are lowercased, so they match.
- List options are sent as lists, whether given comma-separated, repeated or as a JSON array: `token screener --chains ethereum,solana` no longer sends one `"ethereum,solana"` string, `smart-money --labels` accepts a comma-separated list, and a repeated `--addresses` or `research ... --chains` value that itself holds a comma-separated list is split. An empty list (`--chains ,`) is rejected.
- `prediction-market market-screener` and `event-screener` no longer accept `--min-unique-traders-24h` or `--max-volume-24hr`. The REST API has no such filters and rejected every request that used them; the CLI now says so before the request. `--max-unique-traders-24h` and `--min-volume-24hr` are unchanged.
- API validation errors keep the field name (`details.param`, `details.errors[]`), also for browser-session logins, and the message is no longer repeated inside `details`.
- A connection failure (`NETWORK_ERROR`) now says the API key was not checked; a rejected key (`UNAUTHORIZED`) says the connection works.
- All error codes are listed in `docs/error-codes.md`.
