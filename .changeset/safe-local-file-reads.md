---
"nansen-cli": patch
---

Reject symlinks, hard links, and replaced files when reading saved authentication and trading quotes. Validate authentication lock descriptors before use. Claim bridge quotes before signing and block reuse if a post-broadcast execution marker cannot be saved. Authentication reads now require user-owned paths without group or other write permissions on POSIX; repair permissions before retrying an unsafe saved-key read.
