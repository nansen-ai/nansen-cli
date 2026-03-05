---
name: nansen-batch-wallet
description: "Which of these addresses are smart money? Batch-profile a list in one call."
---
```bash
ADDRESSES="0xaddr1,0xaddr2,0xaddr3,..." CHAIN=ethereum
nansen research profiler batch --addresses "$ADDRESSES" --chain $CHAIN --include labels,balance
# → .data.{total, completed, results[]: {address, chain, labels[], balance, error}}
# labels[]: {label, category ("smart_money","fund","social","behavioral","others"), fullname}
# balance: {data[]: {token_symbol, token_amount, price_usd, value_usd}}
```
Keep addresses where any label.category == "smart_money" or "fund".
--include can be "labels", "balance", or "labels,balance". Omit balance for faster identity-only checks.
