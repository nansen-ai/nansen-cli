# TODO

> **Built by agents, for agents.** We prioritize improvements that create the best possible AI agent experience.

## P0 - Trading Agent Support

### Wallet Management
- [ ] `nansen wallet create` — generate a local wallet (per chain), store key securely on disk
- [ ] `nansen wallet address` — print the wallet address for funding
- [ ] `nansen wallet balance` — check wallet balance

### Trading Execution
- [ ] `nansen quote` — get a quote for a DEX swap (chain, token, amount, side)
- [ ] `nansen execute` — sign and submit a trade via Nansen API (takes quote-id)

> These commands are required for `nansen-trading-agent` — the autonomous trading sub-agent.
> Wallet commands should keep the agent self-contained with zero external dependencies.

---

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
