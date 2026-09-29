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

## L2 Coverage

When step 3 returns sparse results on a mainnet EVM address, extend to L2s. `--chain all`
detects each address's chain and covers the EVM chains in a single call, and takes up to
10 addresses at once (every row carries the wallet_address it belongs to):

```bash
nansen research profiler counterparties-batch --addresses "$ADDR" --chain all --days 90 --limit 50
```

Rows come back as contiguous per-wallet blocks ordered by wallet address, so with several
addresses a small page holds one wallet only — raise `--limit` and page with `--page N`.

`counterparties-batch` is capped at 90 days. For a wider window, fall back to the
per-chain loop:

```bash
for CHAIN in base arbitrum optimism polygon; do
  nansen research profiler counterparties --address $ADDR --chain $CHAIN --days 365
done
```

## Cost Warnings

- `trace` is credit-heavy; keep `--width 3` or lower
- The per-chain L2 loop above costs 4 API calls per address; `counterparties-batch --chain all` is 1
- Historical balances reveal past holdings on drained wallets — useful fingerprint
