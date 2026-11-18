---
"nansen-cli": patch
---

An API key, `--x402-payment-signature` value or saved browser session token that contains a line break, NUL or another character that cannot be sent in a request header (for example a curly quote) now fails at once with `INVALID_API_KEY`, `INVALID_INPUT` or `AUTH_STATE_INVALID` and a message that names it. Before, the request was retried four times and reported as `NETWORK_ERROR` with "this is not an API key problem" (or, for `nansen login --api-key`, "Could not verify API key"). The value is never printed. With such a key, a Base swap's outcome simulation now stops the swap with this error instead of skipping the simulation with a warning.
