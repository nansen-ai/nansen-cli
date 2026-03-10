---
"nansen-cli": minor
---

Add `nansen account` command to verify API key and check credit balance

Users can now run `nansen account` to confirm their API key is valid and see
their current plan and remaining credits — without consuming any credits.

This calls the new `GET /api/v1/account` endpoint (ECINT-6365).
