---
"nansen-cli": patch
---

Pin the runtime dependencies (`@noble/curves`, `@noble/hashes`, `@scure/base`, `@ethereumjs/rlp`) to exact versions, so a global install no longer picks up a newly published release of a signing library before it has been reviewed.
