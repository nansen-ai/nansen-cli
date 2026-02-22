---
"nansen-cli": minor
---

Add Privy agentic wallet provider for `nansen wallet` commands.

- Create/list/show/delete Privy server wallets (Ethereum + Solana)
- Check wallet balances
- Send transactions and sign messages via Privy RPC
- Create and manage spending policies (limits, chain restrictions)
- No external dependencies — uses Privy REST API directly
- Requires PRIVY_APP_ID and PRIVY_APP_SECRET env vars

Based on: https://github.com/privy-io/privy-agentic-wallets-skill
