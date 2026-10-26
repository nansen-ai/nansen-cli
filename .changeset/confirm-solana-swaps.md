---
"nansen-cli": patch
---

`trade execute` on Solana now waits for the transaction signature to be confirmed on chain before it reports success, as EVM swaps already do. A transaction that lands with an error fails with `TX_REVERTED`, and one that is not confirmed within 90 seconds fails with `RECEIPT_TIMEOUT` (it may still land, so check the explorer before retrying). Previously both cases printed "Transaction successful" and exited 0.
