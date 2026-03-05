---
"nansen-cli": minor
---

Agent-first secure wallet flow — OS keychain persistence, no interactive prompts

- **New `src/keychain.js`**: Password persistence via OS keychain (macOS Keychain / Linux secret-tool), with base64-encoded `.credentials` file fallback for containers/CI. Zero npm dependencies.
- **Non-interactive by default**: All readline prompts removed. Agents get structured JSON errors (`PASSWORD_REQUIRED`, `API_KEY_REQUIRED`) with actionable instructions. `--human` flag re-enables interactive mode.
- **Two-step wallet creation**: Agent asks user for password, runs `NANSEN_WALLET_PASSWORD=<pw> nansen wallet create`. Password auto-persists to keychain — all future operations are passwordless.
- **New commands**: `wallet secure` (migrate to keychain), `wallet forget-password` (clear from all stores).
- **Bug fixes**: Clear `passwordHash` on last wallet delete, verify password before keychain writes, exit non-zero when keychain migration fails, source-aware error messages.
- **New skill**: `nansen-wallet-migration` for migrating from old `~/.nansen/.env` storage to keychain.
