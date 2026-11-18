---
"nansen-cli": patch
---

Telemetry now sends the `--chain` value only when it is a chain the CLI knows (as its canonical name, so `bsc` is sent as `bnb`) and `UNKNOWN_CHAIN` otherwise, and sends only error codes the CLI knows (those in docs/error-codes.md and the feedback command's API codes), `UNKNOWN` otherwise. `DO_NOT_TRACK=true` and `NANSEN_NO_TELEMETRY=true` now disable telemetry, like `1`. The README documents what telemetry sends and how to turn it off.
