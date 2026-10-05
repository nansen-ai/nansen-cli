---
"nansen-cli": minor
---

`trade execute`: add an opt-in broadcast route for swaps. Set `NANSEN_TRADING_EXECUTION_ROUTE=standard` to broadcast a swap through the execution endpoint that tracks the on-chain outcome server-side. On this route the command reports typed failures (including a confirmed on-chain revert), refuses a duplicate submission of a quote that is already in flight, and no longer prints the `Broadcaster:` line (the route does not report one). The default route is unchanged, so behaviour is identical unless you opt in.
