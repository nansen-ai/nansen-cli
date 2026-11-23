---
"nansen-cli": patch
---

`bridge execute`, `alerts create` and `alerts update` no longer report a connection lost after the request was sent as `NETWORK_ERROR` ("could not reach", retryable). They now return `REQUEST_INDETERMINATE`, because the API may already have applied the request; `bridge execute` says to check `nansen bridge status` before requesting a new quote. A connection that was refused or a host that did not resolve is still `NETWORK_ERROR`.
