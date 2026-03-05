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
Some tokens may return no indicators with no error — not just native tokens. Check for empty result before interpreting. Works on ethereum, solana, base, bnb.
