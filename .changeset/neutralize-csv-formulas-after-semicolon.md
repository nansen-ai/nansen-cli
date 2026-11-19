---
"nansen-cli": patch
---

`--format csv` now also neutralizes formulas that follow a `;` or tab inside a cell. Spreadsheet apps that split lines on `;` (Excel in many European locales) or on tabs no longer evaluate those pieces, and cells containing `;` or a tab are quoted.
