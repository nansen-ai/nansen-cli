---
"nansen-cli": minor
---

`trade execute`: non-gasless swaps now broadcast through the execution route that tracks the on-chain outcome server-side, instead of the deprecated `/execute` route. Set `NANSEN_TRADING_EXECUTION_ROUTE=legacy` to go back to the old route; any value other than `standard` or `legacy` is rejected rather than silently falling back.

Three behaviours change for swaps that previously succeeded, so they are worth knowing before you upgrade:

- **A failed swap no longer falls through to the next candidate quote.** The command stops and reports the failure. Once a transaction hash exists the backend keeps the quote claimed, so the next candidate could only have been rejected anyway — but a command that used to retry silently now surfaces an error and expects you to request a fresh quote.
- **A duplicate submission of a quote that is already in flight is refused**, rather than broadcast a second time.
- **A quote carrying no backend quote id is refused outright** (`MISSING_QUOTE_ID`), because that id is the key the route's duplicate-submission lock is held on, and broadcasting without it would claim a protection that is not there. Every live `/quote` response carries one, so this means a stale or hand-edited quote file: request a fresh quote. This includes a quote that carries only an aggregator's own quote id: the deprecated route accepted that and sent it, but it does not key the lock, so the standard route refuses it rather than submit unprotected.

On this route the command opts into the server-side pre-broadcast simulation, which the endpoint leaves off by default, so a transaction that would revert still does not reach the network. It also surfaces the aggregator's own revert reason alongside the backend's failure code, fails closed if the endpoint reports success without a transaction hash or returns a body that is not this route's shape, and reports a node-rejected broadcast on Solana as an unverified outcome rather than a successful swap (the EVM path resolves that case by polling for a receipt; Solana has no such poll). The `Broadcaster:` line is no longer printed, because this route does not report one.

Two paths deliberately do not move:

- **Gasless swaps stay on the deprecated route.** The standard route has no gasless envelope, so a signed Relay authorization sent there would lose its framing and submit as a plain swap.
- **A WalletConnect wallet broadcasts the swap itself** and never reaches this endpoint. The command now says so, and applies the same stop-at-a-failed-swap rule there — both when the transaction reverts and when the wallet returns no hash at all — rather than prompting for the next candidate.

Approval and allowance-revoke broadcasts also continue to use the deprecated route; it is swaps that moved.
