---
"nansen-cli": patch
---

Fix API key prompt masking: each keystroke was showing the real character followed by `*` (e.g. `f*o*o*`) because the readline interface was active alongside raw mode, causing double output. Moving readline creation into the non-hidden branch eliminates the double-echo and also fixes backspace incorrectly clearing the prompt label.
