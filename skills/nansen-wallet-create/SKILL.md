---
name: nansen-wallet-create
description: Create a new nansen-cli wallet. Use when a user needs to set up a wallet for the first time. Requires a password from the human — never generate one yourself.
---

# Wallet Create

**Step 1 — Ask the human for a password (min 12 chars). Never generate it yourself.**

**Step 2 — Create:**

```bash
NANSEN_WALLET_PASSWORD="<password_from_user>" nansen wallet create
# Or with a custom name:
NANSEN_WALLET_PASSWORD="<password_from_user>" nansen wallet create --name trading
```

After creation the password is saved automatically (OS keychain preferred, `.credentials` fallback).
All future wallet operations retrieve it automatically — no env var needed again.

**Step 3 — Verify:**

```bash
nansen wallet list
nansen wallet show default
```

Rules for agents:
- NEVER generate a password — always ask the human
- NEVER store the password in files, memory, logs, or conversation history
- NEVER use `--human` flag — breaks agents

If you see `⚠ Password loaded from insecure .credentials file`, follow the `nansen-wallet-migration` skill.
