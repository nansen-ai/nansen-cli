---
"nansen-cli": minor
---

**Removed `--gasless` from `trade execute`.** The flag never worked. The deprecated broadcast route it posted to validates its request body strictly and has never accepted the `gasless` or `steps` fields, so every gasless swap was rejected with `Unrecognized keys` before anything was broadcast — on Base and on Solana alike. Passing `--gasless` now fails fast with `GASLESS_REMOVED` instead of signing, posting and failing; re-run without it and the wallet pays its own gas as usual. There is no replacement flag.

This corrects the 2.2.0 release note, which said "Gasless swaps stay on the deprecated route". They did, but that route rejected them; there was no working gasless path to keep.

This removes a published option and its `schema.json` entry, so anything enumerating `trade execute`'s options will see it disappear and any wrapper still passing it will fail. It is released as a minor rather than a major because the flag never completed a swap on any chain: every call already ended in a failed execution, so no working integration can depend on it.

**Removed the `$10` gas-balance bypass.** `trade quote` skipped its native-balance pre-check for any trade worth $10 or more, on the theory that such trades could use a solver-paid route. It never checked whether one was actually in use, so a wallet with no native token passed validation and then failed at broadcast. Gas is now checked on every trade, and the error says to fund the wallet rather than suggesting the removed feature.

The Solana floor comes down from `0.01` SOL to `0.005` SOL in the same change. It had drifted above the `0.005` SOL the CLI itself holds back when you sell the maximum amount of SOL, so a wallet left sitting on exactly that reserve would have been refused its next quote — a contradiction the `$10` bypass had been hiding from every trade worth $10 or more. `0.005` SOL is still a wide margin over a real swap (a 5000-lamport base fee plus at most ~0.00204 SOL of account rent). The Base floor is unchanged.
