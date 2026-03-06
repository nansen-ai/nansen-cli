# Wallet Attribution — Reference

## Expansion Protocol

Run steps 1-2 on the seed address. For every new address found, ask the human:
**"Found `<addr>` via `<signal>` (`<label>`). Want me to query it?"**
On confirm, re-run steps 1-2 on it. Reserve step 3 (counterparties) for the seed address only.

**Stop expanding when:** address is a known protocol/CEX · confidence is Low · already visited · cluster > 10 wallets.

## Attribution Rules

- CEX withdrawal → wallet owner (NOT the CEX)
- Smart account/DCA bot → end-user who funds it (NOT the protocol)
- Safe deployer ≠ owner — identical signer sets across Safes = same controller

## Confidence Scoring

| Confidence | Signals |
|------------|---------|
| **High** | First Funder / shared Safe signers / same CEX deposit address |
| **Medium** | Coordinated balance movements / related-wallets + label match |
| **Exclude** | ENS alone, single CEX withdrawal, single deployer |

## Output Format

`address` · `owner` · `confidence (H/M/L)` · `signals` · `role`

## Cost Warnings

- `trace` is credit-heavy; keep `--width 3` or lower
- L2 counterparty checks add 4 API calls per address:
  `nansen research profiler counterparties --address $ADDR --chain base --days 365`
  (repeat for arbitrum, optimism, polygon)
- Historical balances reveal past holdings on drained wallets — useful fingerprint
