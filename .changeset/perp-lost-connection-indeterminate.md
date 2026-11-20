---
"nansen-cli": patch
---

perp: when the connection to Hyperliquid is lost after the signed request went out (a reset, "other side closed", or a drop while the response is read), the command now fails with `HL_TIMEOUT_INDETERMINATE` and says to check `nansen perp orders` and `nansen perp positions` before retrying. It used to print "Could not reach Hyperliquid: fetch failed" (`HL_NETWORK_ERROR`) or "terminated", although the action may have been applied, so a retry could place an order twice. `HL_NETWORK_ERROR` now means the connection was never made (`ENOTFOUND`, `EAI_AGAIN` or `ECONNREFUSED`) and names that cause. Any other connection failure, such as a TLS error, is also reported as indeterminate. Both codes are now listed in `docs/error-codes.md`.
