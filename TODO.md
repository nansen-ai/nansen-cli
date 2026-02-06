# TODO

> **Built by agents, for agents.** We prioritize improvements that create the best possible AI agent experience.

## High Priority

### ~~Rate Limit Handling~~ ✅
- [x] Auto-detect 429 responses
- [x] Implement exponential backoff with jitter
- [x] Retry enabled by default (3 attempts), `--no-retry` to disable
- [x] Parse and respect `retry-after` headers
- [x] Retry on 429, 500, 502, 503, 504 and network errors

### ~~Structured Error Codes~~ ✅
- [x] Define error code enum: `RATE_LIMITED`, `INVALID_ADDRESS`, `TOKEN_NOT_FOUND`, `UNAUTHORIZED`, `INVALID_CHAIN`, etc.
- [x] Return `code` field in all error responses
- [x] Document error codes in CLAUDE.md

### Schema Discovery
- [ ] Add `nansen schema` command
- [ ] Output JSON schema for all commands and parameters
- [ ] Include parameter types, defaults, and valid values
- [ ] Enable agent introspection without parsing docs

### Field Filtering
- [ ] Add `--fields` flag to select output fields
- [ ] Example: `--fields address,value_usd,pnl_usd`
- [ ] Reduce response size / tokens for agents to process

## Medium Priority

### Response Caching
- [ ] Add optional local cache (SQLite or file-based)
- [ ] Configurable TTL (default 60-300s)
- [ ] `--no-cache` flag to bypass
- [ ] `--cache-ttl` flag to override

### Batch Queries
- [ ] Support multiple addresses: `--addresses '[...]'`
- [ ] Support multiple tokens: `--tokens '[...]'`
- [ ] Reduce N calls to 1 call

## Test Quality

> Based on TDD audit - 2026-02-06

### ~~P0 - Critical~~ ✅
- [x] Refactor CLI for testability (index.js → cli.js extraction)
- [x] Add cli.internal.test.js with direct function imports
- [x] Add fake timers to retry tests (was 8s each, now instant)

### P1 - High Priority
- [x] Test `--table` output formatting
- [ ] Test config priority chain (ENV > ~/.nansen > local config.json) — needs `loadConfig()` exported
- [x] Test `--no-retry` flag actually disables retry
- [x] Test `--retries N` custom retry count (+ fixed bug: `--retries 0` now works)

### P2 - Medium Priority  
- [ ] Test `parseSort` with special characters in field names
- [ ] Test `formatTable` with deeply nested objects
- [ ] Mock login/logout flow (readline + stdin)
- [ ] Test non-JSON error responses (HTML 502 pages)
- [ ] Test HTTP date format in retry-after header

### P3 - Nice to Have
- [ ] Add snapshot tests for `--help` output
- [ ] Document magic test addresses (e.g. Binance hot wallet)
- [ ] Test Bitcoin address validation
- [ ] Test stdin pipe mode for API key input

### Test Smells to Address
- [ ] Remove duplicated `parseArgs` in unit.test.js (now exported from cli.js)
- [ ] Reduce cli.test.js subprocess tests to ~10 smoke tests

## Nice to Have

### Streaming Output
- [ ] `--stream` flag for large result sets
- [ ] Output as JSON lines (newline-delimited JSON)
- [ ] Enable incremental processing by agents

### Shell Completions
- [ ] Bash completions
- [ ] Zsh completions
- [ ] Fish completions

### Distribution
- [ ] Homebrew formula (`brew install nansen-cli`)
- [ ] Docker image

---

*Last updated: 2025-02-06*
