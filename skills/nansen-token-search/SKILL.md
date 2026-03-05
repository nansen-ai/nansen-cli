---
name: nansen-token-search
description: "Resolve a token name or symbol to a contract address. Use this first when you have a token name but need an address for other nansen skills."
---

# Token Search

**Answers:** "What is the contract address for this token?"

```bash
QUERY="<token name or symbol>"

nansen research search --query "$QUERY" --limit 10
# → .data.tokens[]: {name, symbol, chain, address, price, volume_24h, market_cap, rank}

# Confirm the match
TOKEN=<address_from_results>
CHAIN=<chain_from_results>
nansen research token info --token $TOKEN --chain $CHAIN
# → .data.data: {name, symbol, contract_address, spot_metrics, token_details}
```

Use the `address` field as `TOKEN` in all other nansen skills.
If multiple results match, prefer the one with the highest market_cap on the intended chain.
If no results: try ticker symbol only (e.g. "ETH" not "Ethereum").
Note: Hyperliquid results use the symbol as address (e.g. address: "AAVE") — not usable for on-chain token endpoints.
