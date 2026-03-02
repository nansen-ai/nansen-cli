---
"nansen-cli": minor
---

fix: trade quote/execute now output structured JSON; schema command respects wallet and rejects unknown commands; fix deprecated --help examples

## trade quote and execute: JSON output (agent-first)

`nansen trade quote` and `nansen trade execute` previously output only
human-readable text to stdout, returning `undefined` to the CLI runner.
No JSON was emitted — making these commands unusable in agent pipelines
despite the CLI being marketed for agent use.

**What changed:**

- `trade quote` now returns a structured object on success:
  `{ quoteId, chain, walletAddress, quotes: [...], executeCommand }`
  The human-readable summary is preserved on stderr for TTY users.

- `trade execute` now returns a structured object on success:
  `{ status, txHash, chain, chainType, broadcaster, explorerUrl, swapEvents }`

- All validation errors in both commands now throw structured errors
  (caught by the CLI runner and emitted as `{"success":false,"error":"..."}`)
  instead of printing plain text to stderr and exiting without stdout output.
  This includes: missing required params, no wallet configured, invalid quote
  ID, all-quotes-failed, and on-chain reverts.

## schema command: wallet support + unknown-command error

- `nansen schema wallet` previously returned the full schema (the wallet
  command was not in `SCHEMA.commands`, so the lookup fell through to the
  default). `wallet` is now a first-class entry in `schema.json` with
  full subcommand and option definitions.

- `nansen schema <unknown>` previously silently returned the full schema.
  It now returns `{"success":false,"error":"Unknown schema command: ..."}`.

## schema.json: trade execute --quote param added

`trade execute` schema was missing the `--quote` param entirely — the only
required input. Agents reading the schema before calling the command could
not discover this requirement.

## --help examples: fix deprecated command paths

All `--help` example strings and no-arg command examples used the old
pre-research-namespace paths (e.g. `nansen smart-money netflow`) instead
of the current canonical paths (e.g. `nansen research smart-money netflow`).
Fixed in six hardcoded example strings and in the `generateSubcommandHelp`
auto-generated example builder.
