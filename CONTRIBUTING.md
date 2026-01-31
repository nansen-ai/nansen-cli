# Contributing to Nansen CLI

Thanks for your interest in contributing!

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
2. Add the CLI handler in `src/index.js`
3. Add tests in `src/__tests__/api.test.js` and `src/__tests__/cli.test.js`
4. Update `src/__tests__/coverage.test.js` with the new endpoint
5. Update `README.md` with documentation

## Code Style

- ES modules (`import`/`export`)
- Async/await for API calls
- JSDoc comments for public methods
- All output is JSON (for AI agent consumption)

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
- Error message (with `--pretty` flag)
- Expected vs actual behavior

## Questions?

Open an issue or reach out on [Discord](https://discord.gg/nansen).
