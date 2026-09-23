---
"nansen-cli": patch
---

Version comparison (update notifier, `doctor`) reads a prerelease-suffixed component numerically instead of as 0, so `1.2.10-beta` no longer compares below `1.2.9`. Build metadata is now ignored when ranking, so `1.2.3+build.7` and `1.2.3` compare equal, and a prerelease ranks below the release it precedes.
