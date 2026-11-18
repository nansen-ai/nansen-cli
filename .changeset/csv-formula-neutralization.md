---
"nansen-cli": patch
---

`--format csv` now neutralizes text cells that a spreadsheet would run as a formula: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` and quoted. Numbers, including negative values sent as strings, are written unchanged. Header names are escaped the same way, and cells containing a carriage return are now quoted.
