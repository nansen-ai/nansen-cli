---
"nansen-cli": patch
---

Network errors no longer include the underlying fetch error message, which could quote a malformed API key, session token or payment signature. The NETWORK_ERROR envelope, `--debug` trace, `nansen agent`, limit-order and `mcp verify` errors now report the error code (for example `ECONNREFUSED`) or the error name instead.
