# TODO

> **Built by agents, for agents.** We prioritize improvements that create the best possible AI agent experience.

## P0 - High Impact

### Batch Queries
- [ ] Support multiple addresses: `--addresses '[...]'`
- [ ] Support multiple tokens: `--tokens '[...]'`
- [ ] Reduce N calls to 1 call

### Response Caching  
- [ ] Add optional local cache (SQLite or file-based)
- [ ] Configurable TTL (default 60-300s)
- [ ] `--no-cache` flag to bypass
- [ ] `--cache-ttl` flag to override

## P1 - Should Have

### Test Cleanup
- [ ] Remove duplicated `parseArgs` in unit.test.js (now exported from cli.js)
- [ ] Reduce cli.test.js subprocess tests to ~10 smoke tests

### Streaming Output
- [ ] `--stream` flag for large result sets
- [ ] Output as JSON lines (newline-delimited JSON)
- [ ] Enable incremental processing by agents

## P2 - Nice to Have

### Test Coverage Gaps
- [ ] Test config priority chain (ENV > ~/.nansen > local) — needs `loadConfig()` exported
- [ ] Add snapshot tests for `--help` output
- [ ] Document magic test addresses (e.g. Binance hot wallet)
- [ ] Test Bitcoin address validation
- [ ] Test stdin pipe mode for API key input

### Shell Completions
- [ ] Bash completions
- [ ] Zsh completions
- [ ] Fish completions

### Distribution
- [ ] Homebrew formula (`brew install nansen-cli`)
- [ ] Docker image

---

*Last updated: 2026-02-06*
