---
name: nansen-token-search
description: "What is the contract address for this token?"
---
```bash
QUERY="<token name or symbol>"
nansen research search --query "$QUERY" --limit 10
# → .data.tokens[]: {name, symbol, chain, address, price, volume_24h, market_cap, rank}
TOKEN=<address_from_results> CHAIN=<chain_from_results>
nansen research token info --token $TOKEN --chain $CHAIN
# → .data.data: {name, symbol, contract_address, spot_metrics, token_details}
```
Use `address` as TOKEN in other nansen skills. Prefer highest market_cap on intended chain.
If no results: try ticker symbol only (e.g. "ETH" not "Ethereum").
Hyperliquid results use symbol as address (e.g. "AAVE") — not usable for on-chain endpoints.
