---
name: nansen-token-indicators
description: "What is Nansen's signal model read on this token right now?"
---
```bash
TOKEN=<address> CHAIN=ethereum
nansen research token indicators --token $TOKEN --chain $CHAIN
# → .data.token_info: {market_cap_usd, market_cap_group, is_stablecoin}
# → .data.risk_indicators[]: {indicator_type, score, signal, signal_percentile, last_trigger_on}
# → .data.reward_indicators[]: {indicator_type, score, signal, signal_percentile, last_trigger_on}
```
score: "bullish"/"bearish"/"neutral"/"medium"/"low". signal_percentile > 70 = historically significant.
Count bullish reward vs bearish risk indicators. Any high-percentile risk = caution regardless.
Native tokens (SOL, ETH) return empty indicators with no error — use ERC-20/SPL contract addresses. Works on ethereum, solana, base, bnb.
