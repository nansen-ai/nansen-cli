---
"nansen-cli": minor
---

Automatically renew selected browser sessions under the shared credential owner. Coordinate concurrent commands, recover complete stored replacements, and require login after uncertain rotation without replaying consumed tokens or falling back to keys/payments. Renewal upgrades saved authentication metadata to v2; logout retains v2, so recovery requires a tested v2-compatible version; no in-place pre-v2 downgrade is supported.

Renewal preserves the first-party nansen:api grant for account API permissions, including smart alerts and matching-origin hosted trade simulation. Read-only or unscoped credentials are not upgraded. Wallet signing and MCP integration-key provisioning remain separate.

Stop automatic renewal after five consecutive proven non-consuming failures, with a durable counter and cooldown across commands. Malformed retry metadata fails closed without silently switching credentials.
