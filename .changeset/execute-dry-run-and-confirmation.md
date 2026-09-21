---
"nansen-cli": minor
---

`trade execute` and `bridge execute` now take `--dry-run` and `--yes`. `--dry-run` runs the sign-free preflight available from the cached quote, its public signer address, and read-only RPC calls; prints the trade or transfer that would be sent (chain, tokens, amounts, recipient, approvals, fees — plus the current allowance and revert simulation on EVM); and stops before wallet credentials or signing: no wallet password needed, the quote is not consumed, exit code 0. Real execution still resolves and revalidates the live signer. When stdin is an interactive terminal, both commands now print that plan and ask `Broadcast this transaction? [y/N]` before broadcasting; declining exits 1 with nothing signed. `--yes` (`-y`) or `NANSEN_YES=1` skips the prompt. Non-interactive callers — agents, CI, pipes — are unchanged: they proceed without prompting, and `--yes` is accepted there as a no-op.
