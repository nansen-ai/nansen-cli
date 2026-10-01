---
"nansen-cli": minor
---

`nansen wallet list` now prints the standard JSON envelope on stdout, `{"success":true,"data":{"wallets":[...],"defaultWallet":...}}`, so `nansen wallet list | jq .` works and `--pretty`, `--table`, `--format csv` and `--fields` apply to it like any other command. It previously printed a readable summary with no data envelope, which agents could not parse. The output is the same in a terminal and in a pipe; use `--pretty` for readable JSON or `--table` for a table. With no wallets it returns an empty `wallets` list instead of a hint.
