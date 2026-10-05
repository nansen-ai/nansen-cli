---
"nansen-cli": minor
---

Drop support for Node.js 20 (EOL since April 2026). The minimum supported version is now Node.js 22: `engines.node` is `>=22.0.0`, CI tests on Node 22 and 24, and `nansen doctor` reports Node 20 as below the required version.
