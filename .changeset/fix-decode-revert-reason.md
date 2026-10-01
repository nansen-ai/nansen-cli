---
"nansen-cli": patch
---

Decode the reason a trade or bridge transaction reverted on-chain instead of leaving the user with a bare `Transaction reverted on-chain (status: 0x0)` and no next step (issue #81, narrow scope — the revert-decoding half only; the deny-list pre-check half of the original report needs a separate design and isn't part of this fix). `waitForReceipt` now replays a reverted transaction via `eth_call` at the exact block it was mined in and decodes the standard `Error(string)`/`Panic(uint256)` ABI encodings (new `getRevertReason`/`decodeRevertReason` exports in `src/trading.js`), appending a `Reason: ...` clause to the existing error message when a cause is found. Falls back to the bare status message, unchanged, whenever the cause can't be determined (no RPC configured, a network error during replay, or an unrecognized custom-error selector).
