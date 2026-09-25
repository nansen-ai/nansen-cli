---
"nansen-cli": major
---

Plain `nansen login` now requests fresh browser approval and saves a revocable session in the OS credential store, even when NANSEN_API_KEY is set. Scripts that previously used plain login to save an environment key must use explicit `--human` or `--api-key` setup. Environment keys still override saved authentication for commands. Add `--no-browser`, safe machine login events, offline session diagnostics and wallet-preserving logout. Selected sessions renew automatically; rejected or uncertain renewal requires fresh login. Browser login is intended for a gated prerelease cohort before normal-release promotion.

API keys and browser sessions use the same automatic x402 wallet payment behavior for supported HTTP 402 challenges, under existing wallet controls and spending limits. The paid retry sends the payment credential without the account credential and leaves saved authentication unchanged. Authentication and authorization failures never trigger payment; login verification remains non-paying. Existing anonymous automatic payments and manual API-key payments remain supported.

Native credential operations acquire helper-owned execution exclusion before receiving secrets and retain it through executor termination, preventing a surviving helper from overtaking logout recovery after CLI process death. Native-daemon outstanding-write cancellation remains an OS acceptance gap; physical deletion is best effort.

Keep cancellation cleanup conservative after ambiguous issuance, preserve damaged recovery journals with actionable diagnostics, and restrict login/logout telemetry to fixed paths and allowed metadata.

First-party browser sessions request `nansen:api` for API-key-equivalent account permissions, including smart-alert CRUD and trading API operations under existing account/plan/endpoint checks. Read-scoped CLI sessions require fresh login; existing OAuth/MCP read grants are not broadened. Hosted swap simulation now uses the selected credential on the matching trusted API origin, without exposing it to third-party RPCs or granting wallet signing authority.

Hosted simulation rejects selected-account authentication/authorization failures instead of degrading past them; wallet signing checks remain unchanged.

Preserve anonymous hosted-simulation warn-and-proceed behavior on 401/403 while selected account credentials still fail closed. Resolve a missing home environment through the OS home directory, and refuse relative authentication storage paths.

Explicit API-key login now saves the same API URL used to verify the key, preserving staging or custom API configuration.
