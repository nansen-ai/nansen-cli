---
"nansen-cli": patch
---

`nansen mcp verify` now reports an API key that contains a line break, a NUL, a curly quote or another character that cannot be sent in a request header as a bad key ("Copy the key again") instead of a network failure, and no longer prints part of such a key. Every command now also catches keys with control characters such as an ANSI escape code from a coloured paste, which were reported as network errors.
