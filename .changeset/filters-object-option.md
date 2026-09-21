---
"nansen-cli": patch
---

`--filters` is validated as a JSON object before the request is sent. A value such as `--filters '[]'`, `--filters abc` or a repeated `--filters` flag used to be forwarded to the API as-is and only failed there with a 422; it now fails with an `INVALID_PARAMS` error that shows the expected form.
