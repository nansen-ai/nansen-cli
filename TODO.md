# TODO

> **Built by agents, for agents.** We prioritize improvements that create the best possible AI agent experience.

## High Priority

### Rate Limit Handling
- [ ] Auto-detect 429 responses
- [ ] Implement exponential backoff with jitter
- [ ] Add `--retry` flag (or make it default)
- [ ] Surface rate limit headers in response metadata

### Structured Error Codes
- [ ] Define error code enum: `RATE_LIMITED`, `INVALID_ADDRESS`, `TOKEN_NOT_FOUND`, `UNAUTHORIZED`, `INVALID_CHAIN`, etc.
- [ ] Return `errorCode` field in all error responses
- [ ] Document error codes in CLAUDE.md

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
