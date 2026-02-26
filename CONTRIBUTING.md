# Contributing to Nansen CLI

> **Built by agents, for agents.** Read the philosophy section before opening a PR — it's how we decide what gets merged.

---

## CLI Philosophy

The Nansen CLI is a thin, composable interface over Nansen's APIs. It is not a product in itself. Every design decision should pass one test:

*"Does this make it easier for an agent to get data and trade?"*

### 1. Thin wrapper, not a product

The CLI translates commands into API calls and returns structured JSON. It should not contain business logic, caching layers, analytics engines, or smart defaults that obscure what the API actually returned.

- ✅ Pass parameters through to the API
- ✅ Return API responses as clean JSON
- ❌ Transform, aggregate, or "enrich" results beyond basic formatting
- ❌ Build features that belong in the API or the app

### 2. Explicit over implicit — no magic defaults

Agents and scripts need predictable behavior. Defaults that "help" humans create confusion for programmatic callers.

- **No default chain.** A multichain CLI must not silently pick a chain. If `--chain` is required by the API, the CLI requires it. An agent calling `nansen research smart-money netflow` should get an error, not Solana results it didn't ask for.
- **No default timeframes, limits, or sort orders** beyond what the API itself defaults to.
- **Flags mean what they say.** `--limit 10` returns 10. `--chain ethereum` queries Ethereum. No fuzzy matching, no "did you mean...?"

### 3. Composable, not flag-heavy

Each command should do one thing. Combine commands with pipes and scripts, not by adding more flags.

- ✅ `nansen research token screener --chain solana | jq '.[] | .token_address'`
- ✅ Small, focused subcommands
- ❌ `--output-format csv --filter-by-mcap-gt 1000000 --include-social-links --merge-with-holdings`
- ❌ Swiss-army-knife commands that try to do everything

**Rule of thumb:** if a flag requires explaining edge cases, it's probably a separate command or belongs in the agent's logic.

### 4. Errors should be loud and actionable

- Missing required params → clear error with the exact flag needed
- API errors → pass through the API error message, don't swallow it
- Timeouts → fail fast with a clear message (see principle 6)
- Never silently succeed with partial data

### 5. Zero external dependencies

The CLI runs on bare Node.js with zero `node_modules`. This is a hard rule — trivial installation, zero supply chain risk.

- ✅ Node.js built-in `crypto`, `https`, `fs`
- ❌ `axios`, `ethers`, `web3.js`, `chalk`, or any npm package

### 6. Fix slow commands at the source

When a command is slow, the answer is **not** to increase the timeout. Slow responses mean a problem in our API tables, routing, or query patterns.

- If an endpoint is consistently slow → file a bug against the API team
- If an agent reports timeouts → investigate the underlying cause
- **Never merge a PR that just bumps a timeout** without a corresponding API investigation ticket

The CLI's default timeout should be aggressive enough to surface performance problems, not lenient enough to hide them.

### 7. JSON-first, human-readable second

The primary output is structured JSON that agents can parse. Human-friendly output is a convenience layer, never the default.

- Default output: valid JSON (one object or array)
- `--pretty`: formatted JSON with colors
- `--table`: tabular view for terminals
- Never mix formats. Never print log messages to stdout (use stderr).

### 8. Schema as documentation

`nansen schema` is the canonical machine-readable reference. Every command, option, and return field must be in the schema. An agent should be able to call `nansen schema` and know everything it needs.

- New command without schema entry → reject the PR
- Schema describes what exists, not what's aspirational

---

## What We Merge

- Commands that expose new API endpoints with clean 1:1 mapping
- Bug fixes in parameter passing, error handling, or output formatting
- Schema updates that match actual API changes
- Test coverage improvements
- Performance improvements that don't change behavior

## What We Don't Merge

| PR Pattern | Why |
|------------|-----|
| Default chain additions | Multichain means explicit chain selection |
| Timeout bumps without API investigation | File the API bug first |
| "Smart" defaults or convenience logic | Unpredictable for agents |
| New npm dependencies | Zero deps is a feature |
| Output transformations beyond API data | Aggregations, calculations, derived fields belong elsewhere |
| Interactive prompts in normal flow | CLI must work non-interactively (setup like `nansen login` is OK) |
| Chain-specific special cases in CLI | The API handles chain differences |

---

## Getting Started

```bash
git clone https://github.com/nansen-ai/nansen-cli.git
cd nansen-cli
npm install
```

## Development

```bash
# Run tests (mocked, no API key needed)
npm test

# Run tests in watch mode
npm run test:watch

# Run against live API (requires NANSEN_API_KEY)
npm run test:live
```

## Adding New Endpoints

1. Add the API method in `src/api.js`
2. Add the CLI command and schema entry in `src/cli.js`
3. Add tests in `src/__tests__/`
4. Update `README.md` with documentation
5. Verify `nansen schema` includes the new command

## Code Style

- ES modules (`import`/`export`)
- Async/await for API calls
- JSDoc comments for public methods
- All output is JSON (for AI agent consumption)
- No external dependencies — Node.js built-ins only

## Pull Requests

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/new-endpoint`)
3. Make your changes
4. Run tests (`npm test`)
5. Commit with a clear message
6. Push and open a PR

## Reporting Issues

Please include:
- Node.js version
- CLI command that failed
- Error message
- Expected vs actual behavior

## Questions?

Open an issue or reach out on [Discord](https://discord.gg/nansen).
